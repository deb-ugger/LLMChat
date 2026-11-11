#pragma once
#include "TranslateClient.h"
#include <condition_variable>
#include <algorithm>
#include <stdexcept>
#include <chrono>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#include <unordered_map>
/** Short-window batching for the game's synchronous plain-text translation bridge. */
class RuntimeLlmBatcher {
 using Invoke=std::function<std::vector<TranslateResult>(const std::vector<std::string>&)>;
 struct Job{std::string key,text;Invoke invoke;std::promise<TranslateResult> result;};
 std::mutex mutex_;std::condition_variable changed_;std::deque<std::shared_ptr<Job>> pending_;bool stopping_=false;std::vector<std::thread> workers_;
 static void clearUsage(TranslateResult& r){r.promptTokens=r.completionTokens=r.totalTokens=r.cacheReadTokens=r.cacheWriteTokens=0;r.externalCall=false;}
 void worker(){
  for(;;){
   std::vector<std::shared_ptr<Job>> batch;
   {std::unique_lock lock(mutex_);changed_.wait(lock,[&]{return stopping_||!pending_.empty();});if(stopping_&&pending_.empty())return;
    auto first=pending_.front();pending_.pop_front();batch.push_back(first);
    changed_.wait_for(lock,std::chrono::milliseconds(8),[&]{return stopping_||pending_.size()>=7;});
    size_t bytes=first->text.size();
    for(auto it=pending_.begin();it!=pending_.end()&&batch.size()<8;){if((*it)->key==first->key&&bytes+(*it)->text.size()<=8000){bytes+=(*it)->text.size();batch.push_back(*it);it=pending_.erase(it);}else ++it;}
   }
   try{
    std::vector<std::string> texts;std::unordered_map<std::string,size_t> indexes;
    for(auto& job:batch)if(!indexes.contains(job->text)){indexes[job->text]=texts.size();texts.push_back(job->text);}
    std::vector<TranslateResult> values;
    for(int attempt=0;;attempt++){
      values=batch[0]->invoke(texts);if(values.size()!=texts.size())throw std::runtime_error("Runtime translation result count mismatch");
      const bool transient=std::all_of(values.begin(),values.end(),[](const auto& r){return !r.ok&&(r.code=="NETWORK_TIMEOUT"||r.error.find("429")!=std::string::npos||r.error.find("503")!=std::string::npos);});
      if(!transient||attempt>=2)break;
      std::unique_lock lock(mutex_);if(changed_.wait_for(lock,std::chrono::seconds(1<<attempt),[&]{return stopping_;}))break;
    }
    std::vector<bool> delivered(values.size(),false);
    for(auto& job:batch){const auto index=indexes.at(job->text);auto result=values[index];if(delivered[index])clearUsage(result);delivered[index]=true;job->result.set_value(std::move(result));}
   }catch(const std::exception& error){for(auto& job:batch){TranslateResult result;result.error=error.what();result.code="ERROR";job->result.set_value(std::move(result));}}
  }
 }
public:
 RuntimeLlmBatcher(){for(int i=0;i<2;i++)workers_.emplace_back([this]{worker();});}
 ~RuntimeLlmBatcher(){{std::lock_guard lock(mutex_);stopping_=true;}changed_.notify_all();for(auto& thread:workers_)thread.join();}
 std::future<TranslateResult> submit(std::string key,std::string text,Invoke invoke){
  auto job=std::make_shared<Job>();job->key=std::move(key);job->text=std::move(text);job->invoke=std::move(invoke);auto result=job->result.get_future();
  {std::lock_guard lock(mutex_);if(stopping_)throw std::runtime_error("Runtime translation queue closed");pending_.push_back(job);}changed_.notify_all();return result;
 }
};
