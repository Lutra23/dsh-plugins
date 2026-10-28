/**
 * 最小图像编解码层。
 *
 * 只做表情包需要的三件事：解出一张 RGBA 位图、按目标尺寸重采样、再编码回去。
 * 依赖仅 pngjs 与 jpeg-js，二者都没有传递依赖——这是刻意的：插件的宿主是
 * Electron，任何原生模块都要匹配 ABI，纯 JS 编解码把这类风险降到零。
 *
 * 复采样分两档：缩小时用面积平均（box filter），这是下采样的正确做法，
 * 不会像最近邻那样丢线条；放大时用双线性，避免方块感。两者都按 alpha 做
 * 预乘加权，否则透明边缘在缩放后会渗出黑边——表情包大量是透明 PNG，
 * 这一点不处理会非常明显。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')
const jpeg = require('jpeg-js')

/** 支持的输入扩展名 -> 规范格式名。 */
export const IMAGE_FORMATS = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.gif', 'gif'],
  ['.bmp', 'bmp'],
  ['.webp', 'webp'],
])

/** 本模块能真正解码的格式。GIF/BMP/WebP 只做原样直出，不支持缩放。 */
const DECODABLE = new Set(['png', 'jpeg'])

/** 由文件名推格式名；不认识返回 undefined。 */
export function formatOf(fileName) {
  const dot = String(fileName).lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_FORMATS.get(String(fileName).slice(dot).toLowerCase())
}

/** 该格式能否被本模块缩放。 */
export function isDecodable(format) {
  return DECODABLE.has(format)
}

/**
 * 只读文件头取宽高，不解码像素。列表页要对每张图显示尺寸，全解码代价
 * 不可接受，故三种主流格式各自读头部即可。
 * @param buffer - 原始文件字节。
 * @param format - formatOf 得到的形式名。
 * @returns {width, height}，取不到时返回 undefined。
 */
export function readImageSize(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return undefined
  try {
    if (format === 'png') {
      // IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型，宽高为大端 32 位。
      if (buffer.length < 24) return undefined
      if (buffer.readUInt32BE(0) !== 0x89504e47) return undefined
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (format === 'gif') {
      const sig = buffer.toString('ascii', 0, 6)
      if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (format === 'jpeg') {
      // 逐段跳过，直到遇到 SOFn（帧起始）段，其 1..2 字节为高、3..4 为宽。
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15，排除 DHT(0xc4)/JPG(0xc8)/DAC(0xcc)。
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
        }
        // 独立标记（无长度字段）不能按长度跳。
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
          offset += 2
          continue
        }
        const segLength = buffer.readUInt16BE(offset + 2)
        if (segLength < 2) return undefined
        offset += 2 + segLength
      }
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 解码为 RGBA 位图。
 * @param buffer - 原始文件字节。
 * @param format - png 或 jpeg。
 * @returns {width, height, data}，data 为 RGBA 字节；不支持或损坏时 undefined。
 */
export function decode(buffer, format) {
  try {
    if (format === 'png') {
      const png = PNG.sync.read(buffer)
      return { width: png.width, height: png.height, data: png.data }
    }
    if (format === 'jpeg') {
      const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true })
      return { width: raw.width, height: raw.height, data: Buffer.from(raw.data) }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 把 0-255 之外的值夹回边界。 */
function clamp8(value) {
  if (value <= 0) return 0
  if (value >= 255) return 255
  return Math.round(value)
}

/**
 * 重采样 RGBA 位图。
 * @param src - 源 RGBA 字节。
 * @param sw - 源宽。
 * @param sh - 源高。
 * @param dw - 目标宽。
 * @param dh - 目标高。
 * @returns 目标 RGBA 字节。
 */
export function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const downscale = dw <= sw && dh <= sh

  if (downscale) {
    // 面积平均：每个目标像素覆盖一块源区域，按覆盖面积与 alpha 加权。
    const scaleX = sw / dw
    const scaleY = sh / dh
    for (let y = 0; y < dh; y += 1) {
      const y0 = y * scaleY
      const y1 = Math.min((y + 1) * scaleY, sh)
      const syStart = Math.floor(y0)
      const syEnd = Math.ceil(y1)
      for (let x = 0; x < dw; x += 1) {
        const x0 = x * scaleX
        const x1 = Math.min((x + 1) * scaleX, sw)
        const sxStart = Math.floor(x0)
        const sxEnd = Math.ceil(x1)
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        let weightSum = 0
        for (let sy = syStart; sy < syEnd && sy < sh; sy += 1) {
          const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
          if (wy <= 0) continue
          for (let sx = sxStart; sx < sxEnd && sx < sw; sx += 1) {
            const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
            if (wx <= 0) continue
            const w = wx * wy
            const i = (sy * sw + sx) * 4
            const alpha = src[i + 3] / 255
            // 颜色按 alpha 预乘，避免透明像素的黑色污染边缘。
            r += src[i] * w * alpha
            g += src[i + 1] * w * alpha
            b += src[i + 2] * w * alpha
            a += src[i + 3] * w
            weightSum += w
          }
        }
        const o = (y * dw + x) * 4
        if (weightSum > 0 && a > 0) {
          out[o] = clamp8(r / (a / 255))
          out[o + 1] = clamp8(g / (a / 255))
          out[o + 2] = clamp8(b / (a / 255))
          out[o + 3] = clamp8(a / weightSum)
        }
      }
    }
    return out
  }

  // 双线性放大：目标像素反查源坐标，取四邻域按小数部分加权。
  const scaleX = sw / dw
  const scaleY = sh / dh
  for (let y = 0; y < dh; y += 1) {
    const fy = Math.min((y + 0.5) * scaleY - 0.5, sh - 1)
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x += 1) {
      const fx = Math.min((x + 0.5) * scaleX - 0.5, sw - 1)
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const o = (y * dw + x) * 4
      for (let c = 0; c < 4; c += 1) {
        const p00 = src[(y0 * sw + x0) * 4 + c]
        const p10 = src[(y0 * sw + x1) * 4 + c]
        const p01 = src[(y1 * sw + x0) * 4 + c]
        const p11 = src[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p10 - p00) * wx
        const bottom = p01 + (p11 - p01) * wx
        out[o + c] = clamp8(top + (bottom - top) * wy)
      }
    }
  }
  return out
}

/**
 * 编码为 PNG。
 * @param bitmap - {width, height, data} RGBA。
 * @returns PNG 字节。
 */
export function encodePng(bitmap) {
  const png = new PNG({ width: bitmap.width, height: bitmap.height })
  png.data = Buffer.from(bitmap.data)
  return PNG.sync.write(png)
}

/**
 * 把源图缩放到目标宽度（高度按原始宽高比推得，四舍五入且至少 1 像素）。
 * @param buffer - 原始文件字节。
 * @param format - 源格式。
 * @param targetWidth - 目标像素宽。
 * @returns {buffer, width, height, format}，无法缩放时 undefined。
 */
export function resizeToWidth(buffer, format, targetWidth) {
  const source = decode(buffer, format)
  if (source === undefined) return undefined
  const width = Math.max(1, Math.round(targetWidth))
  if (width === source.width) {
    return { buffer, width: source.width, height: source.height, format }
  }
  const height = Math.max(1, Math.round((source.height * width) / source.width))
  const data = resample(source.data, source.width, source.height, width, height)
  const bitmap = { width, height, data }
  // 源是无透明的 JPEG 时继续输出 JPEG：把照片型表情包转 PNG 会让体积翻几倍。
  const hasAlpha = format === 'png'
  if (!hasAlpha) {
    const encoded = jpeg.encode({ data, width, height }, 88)
    return { buffer: encoded.data, width, height, format: 'jpeg' }
  }
  return { buffer: encodePng(bitmap), width, height, format: 'png' }
}
