#!/usr/bin/env python3

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from ceph_hrnet import get_hrnet_w32


SKILL_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.environ.get("CEPH_AUTOPOINT_MODEL_DIR", SKILL_ROOT / "models" / "hrnet-ceph19"))
MODEL_PATH = MODEL_DIR / "best_model.pth"
MODEL_URL = os.environ.get(
    "CEPH_AUTOPOINT_MODEL_URL",
    "https://huggingface.co/cwlachap/hrnet-cephalometric-landmark-detection/resolve/main/best_model.pth",
)
SEED_MODEL_PATH = Path("/Users/hyf/Documents/codex/orthovista-ai-miniapp/local-server/models/hrnet-ceph19/best_model.pth")
MIN_MODEL_BYTES = 300 * 1024 * 1024
INPUT_SIZE = 768
MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
LANDMARKS = [
    ("S", "Sella (蝶鞍中点)"),
    ("N", "Nasion (鼻根点)"),
    ("Or", "Orbitale (眶点)"),
    ("Po", "Porion (耳点)"),
    ("A", "Point A (上齿槽座点)"),
    ("B", "Point B (下齿槽座点)"),
    ("Pog", "Pogonion (颏前点)"),
    ("Me", "Menton (颏下点)"),
    ("Gn", "Gnathion (颏顶点)"),
    ("Go", "Gonion (下颌角点)"),
    ("L1T", "Lower Incisor Tip (下中切牙切端)"),
    ("U1T", "Upper Incisor Tip (上中切牙切端)"),
    ("UL", "Upper Lip (上唇点)"),
    ("LL", "Lower Lip (下唇点)"),
    ("Sn", "Subnasale (鼻唇点)"),
    ("PogS", "Soft Tissue Pogonion (软组织颏前点)"),
    ("PNS", "Posterior Nasal Spine (后鼻棘)"),
    ("ANS", "Anterior Nasal Spine (前鼻棘)"),
    ("Ar", "Articulare (关节点)"),
]
LANDMARK_NAME_MAP = {key: name for key, name in LANDMARKS}
METRIC_DEFINITIONS = {
    "SNA": {
        "label": "上颌相对于前颅底的前后位置",
        "reference": "参考: 82° ± 2°",
        "normal_min": 80,
        "normal_max": 84,
        "required_keys": ["S", "N", "A"],
    },
    "SNB": {
        "label": "下颌相对于前颅底的前后位置",
        "reference": "参考: 79° ± 2°",
        "normal_min": 77,
        "normal_max": 81,
        "required_keys": ["S", "N", "B"],
    },
    "ANB": {
        "label": "上下颌骨前后关系",
        "reference": "参考: 2.7° ± 2°",
        "normal_min": 0.7,
        "normal_max": 4.7,
        "required_keys": ["S", "N", "A", "B"],
    },
    "GoGn-SN": {
        "label": "下颌平面对前颅底平面的倾角",
        "reference": "参考: 32° ± 4°",
        "normal_min": 28,
        "normal_max": 36,
        "required_keys": ["Go", "Gn", "S", "N"],
    },
    "FMA": {
        "label": "下颌平面对 FH 平面的角度",
        "reference": "参考: 25° ± 4°",
        "normal_min": 21,
        "normal_max": 29,
        "required_keys": ["Po", "Or", "Go", "Me"],
    },
    "U1-SN": {
        "label": "上中切牙相对于前颅底平面的倾角",
        "reference": "参考: 102° ± 2°",
        "normal_min": 100,
        "normal_max": 104,
        "required_keys": ["U1R", "U1T", "S", "N"],
    },
    "IMPA": {
        "label": "下中切牙相对于下颌平面的倾角",
        "reference": "参考: 90° ± 5°",
        "normal_min": 85,
        "normal_max": 95,
        "required_keys": ["L1R", "L1T", "Go", "Me"],
    },
}
METRIC_ORDER = ["SNA", "SNB", "ANB", "GoGn-SN", "FMA", "U1-SN", "IMPA"]
MODEL_CACHE = None


def clamp(value, low, high):
    return min(max(value, low), high)


def round1(value):
    return round(float(value), 1)


def sigmoid(value):
    try:
        return 1.0 / (1.0 + math.exp(-float(value)))
    except OverflowError:
        return 0.0 if value < 0 else 1.0


def fail(message):
    raise RuntimeError(message)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def pick_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    mps_backend = getattr(torch.backends, "mps", None)
    if mps_backend and mps_backend.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def ensure_model_present():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists() and MODEL_PATH.stat().st_size >= MIN_MODEL_BYTES:
        return MODEL_PATH

    if SEED_MODEL_PATH.exists() and SEED_MODEL_PATH.stat().st_size >= MIN_MODEL_BYTES:
        shutil.copy2(SEED_MODEL_PATH, MODEL_PATH)
        return MODEL_PATH

    temp_fd, temp_name = tempfile.mkstemp(prefix="ceph-model-", suffix=".pth", dir=str(MODEL_DIR))
    os.close(temp_fd)
    request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "Codex-Ceph-AutoPoint/1.0"})
    try:
        with urllib.request.urlopen(request) as response, open(temp_name, "wb") as target:
            shutil.copyfileobj(response, target)
        os.replace(temp_name, MODEL_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

    if not MODEL_PATH.exists() or MODEL_PATH.stat().st_size < MIN_MODEL_BYTES:
        fail("模型下载失败或文件不完整")
    return MODEL_PATH


def strip_state_dict_prefixes(state_dict):
    cleaned = {}
    for key, value in state_dict.items():
        name = key
        for prefix in ("module.", "backbone.", "model."):
            if name.startswith(prefix):
                name = name[len(prefix) :]
        cleaned[name] = value
    return cleaned


def load_model():
    global MODEL_CACHE
    if MODEL_CACHE is not None:
        return MODEL_CACHE

    ensure_model_present()
    device = pick_device()
    model = get_hrnet_w32(len(LANDMARKS))
    checkpoint = torch.load(MODEL_PATH, map_location=device, weights_only=False)
    state_dict = checkpoint.get("model_state_dict") or checkpoint.get("state_dict") or checkpoint
    result = model.load_state_dict(strip_state_dict_prefixes(state_dict), strict=False)
    model.to(device)
    model.eval()
    MODEL_CACHE = {
        "model": model,
        "device": device,
        "warnings": {
            "missingKeys": len(result.missing_keys),
            "unexpectedKeys": len(result.unexpected_keys),
        },
    }
    return MODEL_CACHE


def read_image(image_path):
    image = Image.open(image_path).convert("RGB")
    original_width, original_height = image.size
    resized = image.resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.BILINEAR)
    image_array = np.asarray(resized).astype(np.float32) / 255.0
    image_array = (image_array - MEAN) / STD
    tensor = torch.from_numpy(image_array.transpose(2, 0, 1)).float().unsqueeze(0)
    return image, tensor, original_width, original_height


def infer_landmarks(image_path):
    loaded = load_model()
    image, tensor, width, height = read_image(image_path)
    tensor = tensor.to(loaded["device"])

    with torch.no_grad():
        output = loaded["model"](tensor).detach().cpu().numpy()

    batch_size, joint_count, heatmap_height, heatmap_width = output.shape
    if batch_size < 1 or joint_count < len(LANDMARKS):
        fail("模型输出通道数不足")

    flattened = output.reshape((batch_size, joint_count, -1))
    indices = np.argmax(flattened, axis=2)
    maxvals = np.amax(flattened, axis=2)
    scale_x = width / max(heatmap_width - 1, 1)
    scale_y = height / max(heatmap_height - 1, 1)
    landmarks = []

    for index, (key, name) in enumerate(LANDMARKS):
        flat_index = int(indices[0, index])
        y_index, x_index = np.unravel_index(flat_index, (heatmap_height, heatmap_width))
        peak = float(maxvals[0, index])
        confidence = peak if 0.0 <= peak <= 1.0 else sigmoid(peak)
        x = round1(x_index * scale_x)
        y = round1(y_index * scale_y)
        landmarks.append(
            {
                "key": key,
                "name": name,
                "x": x,
                "y": y,
                "left": round1(x / width * 100),
                "top": round1(y / height * 100),
                "confidence": round(clamp(confidence, 0.0, 1.0), 3),
                "status": "done",
            }
        )

    return image, landmarks, width, height, loaded


def get_point(point_map, key):
    if key not in point_map:
        fail(f"缺少测量点 {key}")
    return point_map[key]


def angle_at(a, b, c):
    vector1 = {"x": a["x"] - b["x"], "y": a["y"] - b["y"]}
    vector2 = {"x": c["x"] - b["x"], "y": c["y"] - b["y"]}
    length1 = math.hypot(vector1["x"], vector1["y"])
    length2 = math.hypot(vector2["x"], vector2["y"])
    if not length1 or not length2:
        fail("关键点距离为 0，无法计算夹角")
    dot = vector1["x"] * vector2["x"] + vector1["y"] * vector2["y"]
    cosine = clamp(dot / (length1 * length2), -1.0, 1.0)
    return math.degrees(math.acos(cosine))


def acute_angle_between_lines(a, b, c, d):
    vector1 = {"x": b["x"] - a["x"], "y": b["y"] - a["y"]}
    vector2 = {"x": d["x"] - c["x"], "y": d["y"] - c["y"]}
    length1 = math.hypot(vector1["x"], vector1["y"])
    length2 = math.hypot(vector2["x"], vector2["y"])
    if not length1 or not length2:
        fail("关键点距离为 0，无法计算线角")
    dot = vector1["x"] * vector2["x"] + vector1["y"] * vector2["y"]
    cosine = clamp(abs(dot) / (length1 * length2), -1.0, 1.0)
    return math.degrees(math.acos(cosine))


def build_metric(code, value):
    config = METRIC_DEFINITIONS[code]
    rounded = round1(value)
    tone = "success"
    if rounded < config["normal_min"] or rounded > config["normal_max"]:
        overflow = config["normal_min"] - rounded if rounded < config["normal_min"] else rounded - config["normal_max"]
        tone = "danger" if overflow >= 3 else "warn"
    return {
        "code": code,
        "label": config["label"],
        "value": rounded,
        "valueText": f"{rounded}°",
        "reference": config["reference"],
        "tone": tone,
    }


def build_metrics(point_map):
    metrics = []
    metric_map = {}
    unsupported = []

    for code in METRIC_ORDER:
        required_keys = METRIC_DEFINITIONS[code]["required_keys"]
        missing_keys = [key for key in required_keys if key not in point_map]
        if missing_keys:
            unsupported.append({"code": code, "reason": f"缺少 {'、'.join(missing_keys)}"})
            continue

        if code == "SNA":
            metric = build_metric(code, angle_at(get_point(point_map, "S"), get_point(point_map, "N"), get_point(point_map, "A")))
        elif code == "SNB":
            metric = build_metric(code, angle_at(get_point(point_map, "S"), get_point(point_map, "N"), get_point(point_map, "B")))
        elif code == "ANB":
            metric = build_metric(
                code,
                angle_at(get_point(point_map, "S"), get_point(point_map, "N"), get_point(point_map, "A"))
                - angle_at(get_point(point_map, "S"), get_point(point_map, "N"), get_point(point_map, "B")),
            )
        elif code == "GoGn-SN":
            metric = build_metric(code, acute_angle_between_lines(get_point(point_map, "Go"), get_point(point_map, "Gn"), get_point(point_map, "S"), get_point(point_map, "N")))
        elif code == "FMA":
            metric = build_metric(code, acute_angle_between_lines(get_point(point_map, "Po"), get_point(point_map, "Or"), get_point(point_map, "Go"), get_point(point_map, "Me")))
        elif code == "U1-SN":
            metric = build_metric(code, 180 - acute_angle_between_lines(get_point(point_map, "U1R"), get_point(point_map, "U1T"), get_point(point_map, "S"), get_point(point_map, "N")))
        else:
            metric = build_metric(code, acute_angle_between_lines(get_point(point_map, "L1R"), get_point(point_map, "L1T"), get_point(point_map, "Go"), get_point(point_map, "Me")))

        metrics.append(metric)
        metric_map[code] = metric

    return metrics, metric_map, unsupported


def build_review_targets(landmarks):
    return [item["key"] for item in sorted(landmarks, key=lambda item: float(item.get("confidence") or 0))[:3]]


def build_risk_label(metric_map):
    anb = metric_map.get("ANB")
    if anb:
        if anb["value"] >= 4.8:
            return "骨性 II 类倾向"
        if anb["value"] <= 0.5:
            return "骨性 III 类倾向"
    if ("GoGn-SN" in metric_map and metric_map["GoGn-SN"]["value"] >= 36) or ("FMA" in metric_map and metric_map["FMA"]["value"] >= 29):
        return "高角倾向"
    if "U1-SN" in metric_map and metric_map["U1-SN"]["value"] >= 105:
        return "上前牙唇倾"
    if anb or "FMA" in metric_map or "GoGn-SN" in metric_map:
        return "骨面型基本协调"
    return "需结合人工复核判断"


def build_insight(metric_map, confidence, unsupported_metrics):
    messages = []
    anb = metric_map.get("ANB")
    if anb:
        if anb["value"] >= 4.8:
            messages.append("ANB 偏大，提示上颌前突或下颌后缩趋势。")
        elif anb["value"] <= 0.5:
            messages.append("ANB 偏小，需警惕 III 类骨性关系。")
        else:
            messages.append("颌间前后关系接近常用参考范围。")
    else:
        messages.append("当前模型点位集不足以完整计算颌间前后关系，需结合人工定点补齐。")

    u1sn = metric_map.get("U1-SN")
    if u1sn and u1sn["value"] >= 105:
        messages.append("上前牙唇倾较明显，建议关注切牙代偿。")

    gognsn = metric_map.get("GoGn-SN")
    fma = metric_map.get("FMA")
    if (gognsn and gognsn["value"] >= 36) or (fma and fma["value"] >= 29):
        messages.append("垂直向角度偏大，建议重点复核高角风险。")
    elif (gognsn and gognsn["value"] <= 28) or (fma and fma["value"] <= 21):
        messages.append("垂直向角度偏低，需结合低角面型一起判断。")

    if confidence < 90:
        messages.append("模型置信度偏低，建议人工重点复核关键点。")
    else:
        messages.append("本轮自动点定结果适合直接进入人工复核与指标解读。")

    if unsupported_metrics:
        messages.append(f"当前模型暂不支持 {'、'.join(item['code'] for item in unsupported_metrics)} 等依赖根尖点的指标。")

    return "".join(messages)


def build_analysis(landmarks, width, height, engine_note):
    point_map = {item["key"]: item for item in landmarks}
    metrics, metric_map, unsupported_metrics = build_metrics(point_map)
    confidence = round1(sum(item["confidence"] for item in landmarks) / max(len(landmarks), 1) * 100)
    review_targets = build_review_targets(landmarks)
    note = engine_note
    if unsupported_metrics:
        note = f"{engine_note} 当前模型未返回 {'、'.join(item['code'] for item in unsupported_metrics)} 所需完整点位。"

    return {
        "recognition": {
            "identified": len(landmarks),
            "total": len(LANDMARKS),
            "confidence": confidence,
            "statusText": "自动点定完成" if confidence >= 90 else "自动点定完成，建议重点复核",
        },
        "riskLabel": build_risk_label(metric_map),
        "insight": build_insight(metric_map, confidence, unsupported_metrics),
        "note": note,
        "reviewTargets": review_targets,
        "metrics": metrics,
        "unsupportedMetricCodes": [item["code"] for item in unsupported_metrics],
        "supportedMetricCodes": [item["code"] for item in metrics],
    }


def pick_font():
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/SFNS.ttf",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, 18)
            except Exception:
                continue
    return ImageFont.load_default()


def landmark_colors(confidence):
    if confidence < 0.9:
        return (0, 163, 255), (255, 255, 255), (7, 54, 96)
    return (186, 26, 26), (255, 255, 255), (72, 10, 10)


def annotate_image(source_image, landmarks, output_path):
    image = source_image.copy().convert("RGB")
    draw = ImageDraw.Draw(image)
    font = pick_font()

    for item in landmarks:
        x = float(item["x"])
        y = float(item["y"])
        key = item["key"]
        point_fill, point_border, label_fill = landmark_colors(float(item["confidence"]))
        radius = 8

        draw.ellipse([(x - radius - 2, y - radius - 2), (x + radius + 2, y + radius + 2)], fill=point_border)
        draw.ellipse([(x - radius, y - radius), (x + radius, y + radius)], fill=point_fill)

        bbox = draw.textbbox((0, 0), key, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        text_x = x + 12
        text_y = y - 24

        draw.rounded_rectangle(
            [(text_x - 6, text_y - 4), (text_x + text_width + 6, text_y + text_height + 4)],
            radius=8,
            fill=label_fill,
        )
        draw.text((text_x, text_y), key, fill=(255, 255, 255), font=font)

    image.save(output_path)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="")
    parser.add_argument("--patient-name", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def build_output_path(image_path, explicit_output):
    if explicit_output:
        return str(Path(explicit_output).expanduser().resolve())
    source = Path(image_path)
    return str((source.parent / f"{source.stem}-ceph-annotated.png").resolve())


def run_check():
    ensure_model_present()
    loaded = load_model()
    emit(
        {
            "ready": True,
            "version": "ceph-autopoint-skill-1.0.0",
            "note": f"独立 skill 模型可用，设备: {loaded['device']}",
            "modelPath": str(MODEL_PATH),
            "landmarkCount": len(LANDMARKS),
            "warnings": loaded["warnings"],
        }
    )


def run_analysis(args):
    image_path = str(Path(args.image).expanduser().resolve())
    if not os.path.exists(image_path):
        fail(f"图片不存在: {image_path}")

    patient_name = args.patient_name.strip() if args.patient_name else Path(image_path).stem
    output_path = build_output_path(image_path, args.output)
    source_image, landmarks, width, height, loaded = infer_landmarks(image_path)
    analysis = build_analysis(landmarks, width, height, "结果来自独立 ceph-autopoint skill 推理，建议继续人工复核。")
    annotate_image(source_image, landmarks, output_path)

    result = {
        "engine": {
            "key": "hf_hrnet_pytorch",
            "label": "HRNet PyTorch Engine",
            "version": "ceph-autopoint-skill-1.0.0",
            "mode": "hf_hrnet_pytorch",
            "device": str(loaded["device"]),
        },
        "patientName": patient_name,
        "imagePath": image_path,
        "annotatedImagePath": output_path,
        "recognition": analysis["recognition"],
        "riskLabel": analysis["riskLabel"],
        "insight": analysis["insight"],
        "note": analysis["note"],
        "reviewTargets": analysis["reviewTargets"],
        "metrics": analysis["metrics"],
        "supportedMetricCodes": analysis["supportedMetricCodes"],
        "unsupportedMetricCodes": analysis["unsupportedMetricCodes"],
        "landmarks": landmarks,
    }
    emit(result)


def main():
    args = parse_args()
    if args.check:
        run_check()
    else:
        if not args.image:
            fail("Usage: ceph_autopoint.py --image /absolute/path/to/image.png [--patient-name 名称] [--output /absolute/path/to/output.png]")
        run_analysis(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        emit({"ready": False, "message": str(error)})
        raise SystemExit(1)
