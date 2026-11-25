use std::{fs, io::Write, path::{Path, PathBuf}, process::Command};
use serde_json::{json, Value};
use tauri::Manager;
use crate::train_dataset::{work, resource, managed, win};

pub fn write_metadata(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    crate::write_atomic_export(path, |file| file.write_all(&bytes))
        .map_err(|error| error.to_string())
}

fn run_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf,String> {
    if id.is_empty() || !id.chars().all(|c|c.is_ascii_digit() || c=='-') { return Err("运行标识无效".into()); }
    let local=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    let root=local.join("training-runs");managed(&local,&root)?;
    managed(&root,&root.join(format!("run-{id}")))
}

fn metadata(path: &Path) -> Result<Value,String> {
    serde_json::from_slice(&fs::read(path.join("run.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}

pub fn snapshot(dataset: &Path, output: &Path) -> Result<PathBuf,String> {
    let target=output.join("snapshot");fs::create_dir(&target).map_err(|e|e.to_string())?;
    let manifest:Value=serde_json::from_slice(&fs::read(dataset.join("manifest.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let annotation=manifest["annotationsFile"].as_str().ok_or("缺少标注文件")?;
    for name in ["manifest.json","review.csv",annotation] {
        let source=managed(dataset,&dataset.join(name))?;
        fs::copy(source,target.join(name)).map_err(|e|e.to_string())?;
    }
    let annotation_path = target.join(annotation);
    let mut labels: Value = serde_json::from_slice(&fs::read(&annotation_path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let mut changed = false;
    if let Some(samples) = labels["samples"].as_object_mut() {
        for sample in samples.values_mut() {
            if let Some(boxes) = sample.get_mut("mosaic").and_then(|mosaic|mosaic.get_mut("boxes")).and_then(Value::as_array_mut) {
                for item in boxes {
                    if let Some(coordinates) = item.get("box").filter(|value|value.is_array()).cloned() { *item=coordinates;changed=true; }
                }
            }
        }
    }
    if changed { write_metadata(&annotation_path,&labels)?; }
    fs::create_dir(target.join("images")).map_err(|e|e.to_string())?;
    for image in manifest["images"].as_array().ok_or("图片索引无效")? {
        let hash=image["sha256"].as_str().ok_or("图片哈希无效")?;
        if hash.len()!=64 || !hash.chars().all(|c|c.is_ascii_hexdigit()) {return Err("图片哈希无效".into());}
        let name=format!("images/{hash}.png");
        fs::copy(managed(dataset,&dataset.join(&name))?,target.join(name)).map_err(|e|e.to_string())?;
    }
    Ok(target)
}

#[tauri::command]
pub fn list_training_runs(app: tauri::AppHandle, dataset_work_id: String) -> Result<Vec<Value>, String> {
    work(&app, &dataset_work_id)?;
    let local = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    let root = local.join("training-runs");
    if !root.exists() {
        return Ok(vec![]);
    }
    managed(&local, &root)?;
    let mut runs = vec![];
    for entry in fs::read_dir(&root).map_err(|e|e.to_string())? {
        let path=entry.map_err(|e|e.to_string())?.path();managed(&root,&path)?;
        if !path.join("run.json").is_file(){continue;}
        let mut value=metadata(&path)?;
        if value["datasetWorkId"]!=dataset_work_id {continue;}
        if path.join("training-report.json").is_file(){
            value["report"]=serde_json::from_slice(&fs::read(path.join("training-report.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        }
        runs.push(value);
    }
    runs.sort_by(|a, b| b["createdAt"].as_u64().cmp(&a["createdAt"].as_u64()));
    Ok(runs)
}

#[tauri::command]
pub fn read_training_result(app:tauri::AppHandle,run_id:String)->Result<Value,String>{
    let path=run_path(&app,&run_id)?;
    let meta=metadata(&path)?;
    if meta["state"]!="complete" {return Err("该次运行尚无完整结果".into());}
    let report:Value=serde_json::from_slice(&fs::read(path.join("training-report.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let csv=fs::read_to_string(path.join("validation.csv")).map_err(|e|e.to_string())?;
    Ok(json!({"meta":meta,"report":report,"csv":csv,"snapshotPath":path.join("snapshot/manifest.json")}))
}

fn helper(app:&tauri::AppHandle,python_path:Option<&str>,environment_dir:Option<&str>,action:&str,args:&[(&str,String)])->Result<Value,String>{
    let local=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    let environment=crate::training_environment::resolve(&local,python_path,environment_dir);
    let python=environment.python.or(environment.base).ok_or(environment.detail)?;
    let mut command=Command::new(python.path);win::hidden(&mut command);
    command.args(["-X","utf8"]).arg(resource(app)?.join("training-results.py")).arg(action);
    for (key,value) in args {command.arg(key).arg(value);}
    let result=command.output().map_err(|e|e.to_string())?;
    if !result.status.success(){return Err(String::from_utf8_lossy(&result.stderr).into());}
    serde_json::from_slice(&result.stdout).map_err(|e|e.to_string())
}

fn model_dir(comfy:&str)->String{Path::new(comfy).join("ComfyUI/models/mosaic-region-targets").to_string_lossy().into()}

#[tauri::command]
pub async fn training_model_status(app:tauri::AppHandle,comfy_dir:String,python_path:Option<String>,environment_dir:Option<String>)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move||helper(&app,python_path.as_deref(),environment_dir.as_deref(),"status",&[("--directory",model_dir(&comfy_dir))])).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn enable_training_model(
    app: tauri::AppHandle, run_id: String, comfy_dir: String, expected_active_hash: Option<String>, python_path: Option<String>, environment_dir: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if comfy_dir.trim().is_empty() {return Err("请先配置 ComfyUI 模型目录".into());}
        let _exclusive = win::exclusive()?;
        let path = run_path(&app, &run_id)?;
        if metadata(&path)?["state"] != "complete" {
            return Err("仅已完成训练可启用".into());
        }
        let mut args = vec![
            ("--directory", model_dir(&comfy_dir)),
            ("--run", path.to_string_lossy().into()),
        ];
        if let Some(hash) = expected_active_hash {
            args.push(("--expected-hash", hash));
        }
        helper(&app, python_path.as_deref(), environment_dir.as_deref(), "enable", &args)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn correct_training_label(
    app: tauri::AppHandle, run_id: String, sample: String, box_coordinates: [u32; 4],
    label: String, python_path: Option<String>, environment_dir: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _exclusive = win::exclusive()?;
        let run = run_path(&app, &run_id)?;
        let meta = metadata(&run)?;
        let id = meta["datasetWorkId"].as_str().ok_or("缺少工作版本关联")?;
        let dataset = work(&app, id)?;
        helper(&app, python_path.as_deref(), environment_dir.as_deref(), "correct", &[
            ("--directory", dataset.to_string_lossy().into()),
            ("--sample", sample),
            ("--box", serde_json::to_string(&box_coordinates).unwrap()),
            ("--label", label),
        ])
    }).await.map_err(|error| error.to_string())?
}
