import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { encode } from 'jpeg-js'

const MAX_PIXELS = 64 * 1024 * 1024
const { source, destination } = workerData as {source:string;destination:string}
try {
  if ((await stat(source)).size > 25 * 1024 * 1024) throw new Error('Image exceeds the preparation size limit')
  // The bundled WASM decoder includes HEVC support on each host platform.
  const libheif = await createRequire(import.meta.url)('libheif-js/wasm-bundle')
  const decoder = new libheif.HeifDecoder()
  const images = decoder.decode(await readFile(source))
  const image = images.find((value: {is_primary():boolean}) => value.is_primary()) ?? images[0]
  if (!image) throw new Error('HEIC has no decodable primary image')
  const width = image.get_width(), height = image.get_height()
  if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('Image exceeds the preparation pixel limit')
  const pixels = await new Promise<Uint8ClampedArray>((resolve,reject) => {
    image.display({data:new Uint8ClampedArray(width*height*4),width,height}, (result:{data:Uint8ClampedArray}|null) => result ? resolve(result.data) : reject(new Error('HEIC decoding failed')))
  })
  // JPEG has no alpha channel. Composite transparent pixels over white.
  for (let i=0;i<pixels.length;i+=4) {
    const alpha=pixels[i+3]/255
    for(let channel=0;channel<3;channel++) pixels[i+channel]=Math.round(pixels[i+channel]*alpha+255*(1-alpha))
    pixels[i+3]=255
  }
  const output = encode({data:pixels,width,height},90).data
  if (output.length > 20 * 1024 * 1024) throw new Error('Prepared image exceeds the output size limit')
  await writeFile(destination,output,{mode:0o600,flag:'wx'})
  parentPort!.postMessage({ok:true})
} catch {
  parentPort!.postMessage({ok:false})
}
