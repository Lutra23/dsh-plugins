#!/usr/bin/env python
"""GIF -> 动画 WebP：表情包入库前的归一化转换。

库里存的统一是 150×150 动画 WebP（源包通常是 500×500、单文件几 MB 的 GIF）。
这个脚本把「下载目录 -> 待入库目录」这一步固化成可复跑的命令，带幂等与 manifest。

用法：
  python tools/gif2webp.py \
      --src "C:\\Users\\szou5\\Desktop\\蓝色大肥鱼表情包" \
      --dest "C:\\Users\\szou5\\.dsh\\emoji\\.staging\\feiyu\\images" \
      --strip-prefix 蓝色大肥鱼 --size 150 --quality 80 --method 5

名字推导：去掉 --strip-prefix 前缀，再去掉结尾的 _YYYY-MM-DD-HH-MM-SS 时间戳。
例：蓝色大肥鱼_哭 1_2026-08-18-14-07-00.gif -> 哭 1.webp

两点须知：
1. 连续完全相同的帧会被 Pillow 的 WebP 编码器合并、时长累加——这是预期行为
   （源 GIF 常见「一张图停 19 帧」），manifest 里 frames_in > frames_out 不是丢帧。
2. 每帧按 LANCZOS 缩放到 size×size。源必须是方图；非方图会在 manifest 里标
   non_square 并由 --pad 决定是拉伸还是留白，免得悄悄变形。

依赖只有 Pillow。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

from PIL import Image, ImageSequence

STAMP = re.compile(r"_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$")
SOURCE_EXT = (".gif", ".png", ".webp", ".jpg", ".jpeg", ".bmp")


def parse_args(argv):
    p = argparse.ArgumentParser(description="GIF -> 150×150 动画 WebP")
    p.add_argument("--src", required=True, help="源目录（下载下来的原始表情包）")
    p.add_argument("--dest", required=True, help="目标 images 目录（会被创建）")
    p.add_argument("--strip-prefix", default="", help="要剥掉的名字前缀，如 蓝色大肥鱼")
    p.add_argument("--size", type=int, default=150, help="目标边长，默认 150")
    p.add_argument("--quality", type=int, default=80, help="WebP 质量，默认 80")
    p.add_argument("--method", type=int, default=5, help="WebP 压缩档 0-6，默认 5")
    p.add_argument("--force", action="store_true", help="目标已存在也重转")
    p.add_argument("--only", default="", help="只转名字包含该子串的文件（调试用）")
    p.add_argument("--manifest", default="", help="manifest 输出路径，默认 <dest>/../manifest.json")
    return p.parse_args(argv)


def name_of(file_name: str, strip_prefix: str) -> str:
    base = os.path.splitext(file_name)[0]
    if strip_prefix and base.startswith(strip_prefix + "_"):
        base = base[len(strip_prefix) + 1:]
    return STAMP.sub("", base).strip()


def convert(src_path: str, dest_path: str, size: int, quality: int, method: int, pad: bool):
    """返回 (frames_in, frames_out, duration_total_ms, size_in, size_out, non_square)。"""
    with Image.open(src_path) as im:
        src_size = im.size
        non_square = src_size[0] != src_size[1]
        frames = []
        durations = []
        for frame in ImageSequence.Iterator(im):
            durations.append(int(frame.info.get("duration") or im.info.get("duration") or 40))
            rgba = frame.convert("RGBA")
            if non_square:
                if pad:  # 等比缩放后贴到透明方底上，不裁内容
                    side = max(src_size)
                    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                    scale = size / side
                    small = rgba.resize((max(1, round(src_size[0] * scale)), max(1, round(src_size[1] * scale))), Image.LANCZOS)
                    canvas.paste(small, ((size - small.width) // 2, (size - small.height) // 2), small)
                    rgba = canvas
                else:
                    rgba = rgba.resize((size, size), Image.LANCZOS)  # 拉伸，manifest 已标 non_square
            else:
                rgba = rgba.resize((size, size), Image.LANCZOS)
            frames.append(rgba)
        frames[0].save(
            dest_path,
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            lossless=False,
            quality=quality,
            method=method,
        )
    with Image.open(dest_path) as out:
        frames_out = getattr(out, "n_frames", 1)
    return len(frames), frames_out, sum(durations), os.path.getsize(src_path), os.path.getsize(dest_path), non_square


def main(argv):
    args = parse_args(argv)
    src = os.path.abspath(args.src)
    dest = os.path.abspath(args.dest)
    if not os.path.isdir(src):
        print(f"源目录不存在：{src}", file=sys.stderr)
        return 2
    os.makedirs(dest, exist_ok=True)

    files = sorted(
        f for f in os.listdir(src)
        if os.path.isfile(os.path.join(src, f)) and f.lower().endswith(SOURCE_EXT)
    )
    if args.only:
        files = [f for f in files if args.only in f]

    records = []
    done = skipped = failed = 0
    t_all = time.time()
    for i, f in enumerate(files, 1):
        name = name_of(f, args.strip_prefix)
        if name == "":
            print(f"[{i}/{len(files)}] 跳过（名字为空）：{f}")
            continue
        target = os.path.join(dest, name + ".webp")
        if os.path.exists(target) and not args.force:
            skipped += 1
            continue
        try:
            t0 = time.time()
            fi, fo, dur, si, so, ns = convert(os.path.join(src, f), target, args.size, args.quality, args.method, pad=False)
            done += 1
            records.append({
                "name": name, "source": f, "target": os.path.basename(target),
                "frames_in": fi, "frames_out": fo, "duration_ms": dur,
                "bytes_in": si, "bytes_out": so, "seconds": round(time.time() - t0, 2),
                "non_square": ns,
            })
            print(f"[{i}/{len(files)}] {name}  {fi}->{fo} 帧  {si // 1024}KB->{so // 1024}KB  {time.time() - t0:.2f}s", flush=True)
        except Exception as error:  # 单个文件失败不该中断整批
            failed += 1
            records.append({"name": name, "source": f, "error": str(error)})
            print(f"[{i}/{len(files)}] 失败 {name}：{error}", flush=True)

    manifest = {
        "src": src, "dest": dest, "size": args.size, "quality": args.quality, "method": args.method,
        "strip_prefix": args.strip_prefix, "total": len(files), "converted": done, "skipped": skipped,
        "failed": failed, "seconds": round(time.time() - t_all, 1), "records": records,
    }
    manifest_path = args.manifest or os.path.join(os.path.dirname(dest), "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print(f"完成：转 {done} / 跳 {skipped} / 失败 {failed}，用时 {manifest['seconds']}s")
    print(f"manifest: {manifest_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
