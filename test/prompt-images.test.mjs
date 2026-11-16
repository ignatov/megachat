import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { IMAGE_PLACEHOLDER, imagePaths, limitImages, MAX_IMAGE_BYTES, promptImages } from '../src/PromptImages.mjs'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')])

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'megachat-images-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(join(root, 'air'), { recursive: true })
  return root
}

test('the screenshot of Air in the text gives one image, and the text stays', async t => {
  const root = await home(t)
  const path = join(root, 'air', 'AIR_Screenshot_1.png')
  await writeFile(path, PNG)
  const text = `look @${path} ![Image](<${path}>)`
  const { images, notes } = await promptImages(text, [], { home: root })
  assert.deepEqual(images, [{ mimeType: 'image/png', data: PNG.toString('base64') }])
  assert.deepEqual(notes, [])
  assert.deepEqual(imagePaths(`@${root}/a.png, [x](file://${root}/b%20c.jpg) [y](${root}/d.txt)`, root).sort(), [`${root}/a.png`, `${root}/b c.jpg`])
})

test('a missing file, a file out of the home, a bad format and a large file give notes, no image', async t => {
  const root = await home(t)
  const outside = await mkdtemp(join(tmpdir(), 'megachat-outside-'))
  t.after(() => rm(outside, { force: true, recursive: true }))
  await writeFile(join(outside, 'a.png'), PNG)
  await writeFile(join(root, 'text.png'), 'not an image')
  await writeFile(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
  const text = [`@${root}/missing.png`, `@${join(outside, 'a.png')}`, `@${root}/text.png`, `@${root}/big.png`].join(' ')
  const { images, notes } = await promptImages(text, [{ mimeType: 'application/pdf', data: 'AAAA' }], { home: root })
  assert.deepEqual(images, [])
  assert.deepEqual(notes, [
    message('prompt.imageSkipped', '#1', message('prompt.imageSkipped.unsupported')),
    message('prompt.imageSkipped', `${root}/missing.png`, message('prompt.imageSkipped.missing')),
    message('prompt.imageSkipped', join(outside, 'a.png'), message('prompt.imageSkipped.outside')),
    message('prompt.imageSkipped', `${root}/text.png`, message('prompt.imageSkipped.unsupported')),
    message('prompt.imageSkipped', `${root}/big.png`, message('prompt.imageSkipped.tooLarge')),
  ])
})

test('a prompt holds at most 4 images', async t => {
  const root = await home(t)
  const inline = Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: PNG.toString('base64') }))
  const { images, notes } = await promptImages('', inline, { home: root })
  assert.equal(images.length, 4)
  assert.equal(notes.length, 1)
})

test('a request holds the images of the last 3 messages with images, and the conversation keeps all', async t => {
  const root = await home(t)
  const fake = fauxProvider()
  const requests = []
  fake.setResponses(Array(4).fill(async context => { requests.push(context.messages); return fauxAssistantMessage('Seen.') }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {}, { home: root })
  t.after(() => service.close())
  const paths = []
  for (let index = 0; index < 4; index++) {
    paths.push(join(root, 'air', `shot-${index}.png`))
    await writeFile(paths[index], Buffer.concat([PNG, Buffer.from(String(index))]))
    const receipt = await service.submit(`request-${index}`, `Look @${paths[index]}`)
    await service.waiters.get(receipt.mainRunId)
  }
  const last = requests.at(-1).filter(model => model.role === 'user')
  const counts = last.map(model => model.content.filter(block => block.type === 'image').length)
  assert.deepEqual(counts, [0, 1, 1, 1])
  assert.equal(last[0].content.find(block => block.type === 'text').text.includes(paths[0]), true)
  assert.deepEqual(limitImages(last, 3), last)
  const texts = messages => messages.flatMap(model => Array.isArray(model.content) ? model.content : []).filter(block => block.type === 'text' && block.text === IMAGE_PLACEHOLDER)
  assert.equal(texts(requests.at(-1)).length, 1)
  assert.equal(texts(limitImages(requests.at(-1), 1)).length, 3)
})
