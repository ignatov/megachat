// The setup note on its own: the note for a fresh conversation with a pending setup, its single delivery, its wait for
// an idle conversation, the drop at the first input of the user, and the states that get no note.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { message } from '../src/messages.mjs'
import { startOnboardingNote } from '../src/MegachatOnboarding.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { NOTE_KIND } from '../src/SessionNotes.mjs'
import { waitForState } from '../src/waitForState.mjs'

const pending = () => true
const RULES = new URL('../resources/instructions-onboarding.md', import.meta.url)

async function open(t, { onboarding } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-onboarding-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const settingsPath = join(root, 'settings.json')
  if (onboarding) await writeFile(settingsPath, JSON.stringify({ schema: 1, onboarding, defaults: 2, values: {} }), { mode: 0o600 })
  const fake = fauxProvider()
  fake.setResponses(Array.from({ length: 10 }, (_, index) => () => fauxAssistantMessage(`Answer ${index + 1}.`)))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false }, environment: {} })
  await service.resume()
  t.after(() => service.close())
  const entries = async () => (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
  const notes = async () => (await entries()).filter(entry => entry.kind === NOTE_KIND)
  const flag = async () => (await service.state.snapshot()).onboardingOffer
  const idle = () => waitForState(service.state, state => state.current === null ? true : undefined)
  return { service, notes, flag, idle, fake }
}

const busy = state => { state.current = { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' } }

test('a fresh conversation gets one setup note with no model request, and a second start adds none', { timeout: 20000 }, async t => {
  const { service, notes, flag, fake } = await open(t)
  assert.equal(await flag(), null)
  const first = startOnboardingNote(service.state, pending)
  t.after(() => first.close())
  await first.done
  const written = await notes()
  assert.equal(written.length, 1)
  assert.equal(written[0].data.type, 'onboarding')
  assert.equal(written[0].model[0].content[0].text, message('onboarding.offer'))
  assert.match(written[0].model[0].content[0].text, /^Welcome to Megachat\./)
  assert.equal(await flag(), 'offered')
  assert.equal(fake.state.callCount, 0)
  // A restart and a reconnect start the driver again.
  const second = startOnboardingNote(service.state, pending)
  t.after(() => second.close())
  await second.done
  assert.equal((await notes()).length, 1)
})

test('the note waits while a turn runs and comes when the conversation is idle', { timeout: 20000 }, async t => {
  const { service, notes, flag } = await open(t)
  await service.state.change(busy)
  assert.equal(await service.state.writeOnboardingNote(pending), false)
  assert.equal((await notes()).length, 0)
  const driver = startOnboardingNote(service.state, pending, { retryMs: 50 })
  t.after(() => driver.close())
  await delay(200)
  assert.equal((await notes()).length, 0)
  await service.state.change(state => { state.current = null })
  await driver.done
  assert.equal((await notes()).length, 1)
  assert.equal(await flag(), 'offered')
})

test('a stop of the daemon ends the tries, and the next daemon writes the note', { timeout: 20000 }, async t => {
  const { service, notes } = await open(t)
  await service.state.change(busy)
  const first = startOnboardingNote(service.state, pending, { retryMs: 50 })
  await delay(150)
  first.close()
  await first.done
  await service.state.change(state => { state.current = null })
  await delay(150)
  assert.equal((await notes()).length, 0)
  const second = startOnboardingNote(service.state, pending)
  t.after(() => second.close())
  await second.done
  assert.equal((await notes()).length, 1)
})

test('when the user writes first, the note never comes and the flow of today applies', { timeout: 20000 }, async t => {
  const { service, notes, flag, idle } = await open(t)
  await service.submit('hello', 'hello')
  assert.equal(await flag(), 'dropped')
  await idle()
  const driver = startOnboardingNote(service.state, pending)
  t.after(() => driver.close())
  await driver.done
  assert.equal((await notes()).length, 0)
  assert.equal(await flag(), 'dropped')
  assert.match(await readFile(RULES, 'utf8'), /Offer the setup one time only\./)
})

test('a done or skipped setup gets no note, and a setup that the user runs again works as before', { timeout: 20000 }, async t => {
  for (const onboarding of ['done', 'skipped']) {
    const { service, notes, flag } = await open(t, { onboarding })
    const driver = startOnboardingNote(service.state, () => service.settings.onboarding === 'pending')
    await driver.done
    driver.close()
    assert.equal((await notes()).length, 0, onboarding)
    assert.equal(await flag(), null)
  }
  // The user asks for the setup in a turn. That turn is an input of the user, so the note does not come.
  const { service, notes, idle } = await open(t, { onboarding: 'done' })
  await service.submit('again', 'Run the setup again.')
  await idle()
  await service.settings.setOnboarding('pending')
  const driver = startOnboardingNote(service.state, () => service.settings.onboarding === 'pending')
  t.after(() => driver.close())
  await driver.done
  assert.equal((await notes()).length, 0)
})

test('a state of an earlier build gets the field from its conversation', { timeout: 20000 }, async t => {
  const fresh = await open(t)
  await fresh.service.state.change(state => { delete state.onboardingOffer })
  await fresh.service.state.initialize()
  assert.equal(await fresh.flag(), null)
  const old = await open(t)
  await old.service.submit('hello', 'hello')
  await old.idle()
  await old.service.state.change(state => { delete state.onboardingOffer })
  await old.service.state.initialize()
  assert.equal(await old.flag(), 'dropped')
  const driver = startOnboardingNote(old.service.state, pending)
  t.after(() => driver.close())
  await driver.done
  assert.equal((await old.notes()).length, 0)
})

test('the setup rules know the note', async () => {
  const rules = await readFile(RULES, 'utf8')
  assert.match(rules, /Do not offer the setup again when the conversation holds the note that starts with Welcome to Megachat\./)
})
