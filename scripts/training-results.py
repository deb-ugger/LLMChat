"""Inspect, publish or correct a managed training run. Invoked by fixed desktop commands."""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.training-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def status(directory):
    active = directory / 'active.pt'
    model_hash = digest(active)
    metadata = directory / 'active.json'
    source = json.loads(metadata.read_bytes()) if metadata.is_file() else None
    if source and source.get('hash') != model_hash:
        source = None
    return {'hash': model_hash, 'source': source}


def enable(run, directory, expected_hash, variant=None):
    artifact = run / variant if variant else run
    model = artifact / 'mobilenet-region-classifier.pt'
    import torch
    state = torch.load(model, map_location='cpu', weights_only=True)
    if state.get('format') not in ('mosaic-target-evidence-v1', 'mosaic-target-evidence-v2'):
        raise ValueError('部位分类器格式不匹配')
    current = status(directory)
    if current['hash'] != expected_hash:
        raise ValueError('当前线上模型已变化，请重新查看对照后启用')
    meta = json.loads((run / 'run.json').read_bytes())
    report = json.loads((artifact / 'training-report.json').read_bytes())
    data = model.read_bytes()
    source = {'runId': meta['runId'], 'createdAt': meta['createdAt'],
              'accuracy': report['agreement'], 'variant': report.get('variant'), 'hash': hashlib.sha256(data).hexdigest()}
    directory.mkdir(parents=True, exist_ok=True)
    active, receipt = directory / 'active.pt', directory / 'active.json'
    previous = receipt.read_bytes() if receipt.is_file() else None
    # Publish the provenance first. A failed atomic model replacement leaves the
    # original model intact and restores its previous provenance.
    atomic(receipt, json.dumps(source, ensure_ascii=False).encode('utf-8'))
    try:
        atomic(active, data)
    except Exception:
        if previous is None:
            receipt.unlink(missing_ok=True)
        else:
            atomic(receipt, previous)
        raise
    return status(directory)


def correct(work, sample, box, label):
    if label not in ('male_external', 'female_external', 'other'):
        raise ValueError('部位标签无效')
    manifest = json.loads((work / 'manifest.json').read_bytes())
    truth = json.loads((work / manifest['annotationsFile']).read_bytes())
    annotation = truth['samples'].get(sample, {}).get('mosaic', {})
    matched_box = next((value for value in annotation.get('boxes', [])
                        if (value.get('box') if isinstance(value, dict) else value) == box), None)
    if annotation.get('state') != 'present' or matched_box is None:
        raise ValueError('工作版本的蒙版已变化，请先在数据集页核对')
    path = work / 'review.csv'
    with path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file)
        fields, rows = reader.fieldnames, list(reader)
    matches = [row for row in rows if row['sample'] == sample and json.loads(row['box']) == box]
    if len(matches) != 1:
        raise ValueError('工作版本中未找到唯一的蒙版人工确认行')
    matches[0]['corrected_part'] = label
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    previous_review = path.read_bytes()
    atomic(path, stream.getvalue().encode('utf-8'))
    if isinstance(matched_box, dict):
        matched_box['part'] = label
        try:
            atomic(work / manifest['annotationsFile'],
                   (json.dumps(truth, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
        except Exception:
            atomic(path, previous_review)
            raise
    return {'saved': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['status', 'enable', 'correct'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--run', type=Path)
    parser.add_argument('--expected-hash')
    parser.add_argument('--variant', choices=['A', 'B', 'C'])
    parser.add_argument('--sample')
    parser.add_argument('--box')
    parser.add_argument('--label')
    args = parser.parse_args()
    if args.action == 'enable':
        result = enable(args.run, args.directory, args.expected_hash, args.variant)
    elif args.action == 'correct':
        result = correct(args.directory, args.sample, json.loads(args.box), args.label)
    else:
        result = status(args.directory)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
