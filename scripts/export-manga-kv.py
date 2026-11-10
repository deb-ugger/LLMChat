"""Export the existing Manga OCR decoder weights with explicit KV inputs/outputs.
Developer tool only; application inference has no Python dependency.
"""
import sys,json,argparse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("--output",required=True);p.add_argument("--model-dir",required=True);args=p.parse_args()
import torch,numpy as np
from transformers import BertLMHeadModel
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"backend/build/kv-export-deps"))
import onnx,onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic,QuantType
torch.set_num_threads(4)
out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
# Reuse installed quantized weights; no second upstream model download.
from transformers import BertConfig
root=Path(__file__).resolve().parents[1]
installed=Path(args.model_dir).resolve()
raw_config=json.loads((installed/"config.json").read_text(encoding="utf-8"))
config=BertConfig.from_dict(raw_config["decoder"]);config._attn_implementation="eager"
decoder=BertLMHeadModel(config).eval()
graph=onnx.load(str(installed/"onnx/decoder_model_quantized.onnx")).graph
values={v.name:onnx.numpy_helper.to_array(v).copy() for v in graph.initializer}
for node in graph.node:
 if node.op_type=="Identity" and node.input[0] in values:values[node.output[0]]=values[node.input[0]]
state={}
for name,value in values.items():
 if name.startswith("decoder.") and not name.endswith(("_quantized","_scale","_zero_point")):state[name.removeprefix("decoder.")]=torch.from_numpy(value.copy())
for node in graph.node:
 if node.op_type=="MatMulInteger":
  key=node.name.removeprefix("/decoder/").removesuffix("/MatMul_quant").replace("/",".")+".weight"
  q=node.input[1];base=q.removesuffix("_quantized")
  array=(values[q].astype(np.float32)-values[base+"_zero_point"])*values[base+"_scale"]
  state[key]=torch.from_numpy(array.T.copy())
for key in decoder.state_dict():
 base="decoder."+key
 if base+"_quantized" in values:
  state[key]=torch.from_numpy(((values[base+"_quantized"].astype(np.float32)-values[base+"_zero_point"])*values[base+"_scale"]).copy())
# ONNX constant folding aliases tied weights and identical initial biases.
for node in graph.node:
 if node.op_type=="Identity":
  a=node.input[0].removeprefix("decoder.");b=node.output[0].removeprefix("decoder.")
  if a in state:state[b]=state[a]
if "cls.predictions.decoder.weight" not in state:state["cls.predictions.decoder.weight"]=state["bert.embeddings.word_embeddings.weight"]
if "cls.predictions.decoder.bias" not in state and "cls.predictions.bias" in state:state["cls.predictions.decoder.bias"]=state["cls.predictions.bias"]
missing,extra=decoder.load_state_dict(state,strict=False)
if missing:raise RuntimeError("Unmapped decoder weights: "+repr(missing))
config=decoder.config;layers=config.num_hidden_layers;heads=config.num_attention_heads;head=config.hidden_size//heads
class Initial(torch.nn.Module):
 def __init__(self):
  super().__init__();self.model=decoder
 def forward(self,ids,hidden):
  r=self.model(input_ids=ids,encoder_hidden_states=hidden,use_cache=True,return_dict=True)
  return (r.logits,)+tuple(v for layer in r.past_key_values for v in layer)
class Cached(torch.nn.Module):
 def __init__(self):
  super().__init__();self.model=decoder
 def forward(self,ids,hidden,*past):
  cache=tuple(tuple(past[i*4+j] for j in range(4)) for i in range(layers))
  r=self.model(input_ids=ids,encoder_hidden_states=hidden,past_key_values=cache,use_cache=True,return_dict=True)
  return (r.logits,)+tuple(v for layer in r.past_key_values for v in layer)
ids=torch.tensor([[2]],dtype=torch.long);hidden=torch.randn(1,197,config.hidden_size)
names=[f"present.{i}.{kind}" for i in range(layers) for kind in ("self.key","self.value","cross.key","cross.value")]
inputs=[name.replace("present.","past.") for name in names]
with torch.no_grad():
 initial=Initial().eval();cached=Cached().eval();first=initial(ids,hidden)
 for name,module,values,inames in [("decoder_kv_init",initial,(ids,hidden),["input_ids","encoder_hidden_states"]),("decoder_kv_step",cached,(ids,hidden,*first[1:]),["input_ids","encoder_hidden_states",*inputs])]:
  axes={"input_ids":{0:"batch",1:"tokens"},"encoder_hidden_states":{0:"batch",1:"encoder_tokens"},"logits":{0:"batch",1:"tokens"}}
  for n in names:axes[n]={0:"batch",2:"total_tokens" if ".self." in n else "encoder_tokens"}
  for n in inputs:
   if n in inames:axes[n]={0:"batch",2:"past_tokens" if ".self." in n else "encoder_tokens"}
  raw=out/(name+".onnx");target=out/(name+"_quantized.onnx")
  torch.onnx.export(module,values,raw,input_names=inames,output_names=["logits",*names],dynamic_axes=axes,opset_version=17,do_constant_folding=True)
  onnx.checker.check_model(str(raw));quantize_dynamic(str(raw),str(target),weight_type=QuantType.QUInt8)
  raw.unlink()
 sessions=[ort.InferenceSession(str(out/(name+"_quantized.onnx")),providers=["CPUExecutionProvider"]) for name in ("decoder_kv_init","decoder_kv_step")]
 prefix=[2];past=None
 for i in range(12):
  full=sessions[0].run(None,{"input_ids":np.array([prefix],dtype=np.int64),"encoder_hidden_states":hidden.numpy()})
  if past is None:step=full
  else:
   feed={"input_ids":np.array([[prefix[-1]]],dtype=np.int64),**dict(zip(inputs,past))}
   if "encoder_hidden_states" in [v.name for v in sessions[1].get_inputs()]:feed["encoder_hidden_states"]=hidden.numpy()
   allowed={v.name for v in sessions[1].get_inputs()}
   step=sessions[1].run(None,{k:v for k,v in feed.items() if k in allowed})
  if np.argmax(full[0][0,-1])!=np.argmax(step[0][0,-1]):raise RuntimeError("Cached/full token mismatch")
  prefix.append(int(np.argmax(step[0][0,-1])));past=step[1:]
 (out/"kv-manifest.json").write_text(json.dumps({"version":1,"layers":layers,"heads":heads,"headSize":head,"verifiedTokens":12,"source":"onnx-community/manga-ocr-base-ONNX","weights":"recovered from installed INT8 decoder"}),encoding="utf-8")
 print("KV export and 12-token full/cached equivalence: PASS",flush=True)
