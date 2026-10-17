// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake Gatus: discovery, states,
// transitions and scene events, persistence across restarts, errors, scene
// actions, the widget, quiet logs, and the reading timer of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS, INSTANCE_KEYS, instanceIds } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import {
  BASE,
  FakeGatus,
  TOKEN,
  createClock,
  createDevices,
  createWorld,
  endpoint,
  idsOf,
  result,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const MINUTE = 60_000;

test('one device per endpoint and one for the instance, proposed in Discovery, nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Gatus', 'Website', 'API', 'NAS', 'Backups'],
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  assert.deepEqual(devices[1].params, [
    { name: 'GATUS_KEY', value: 'core_website' },
    { name: 'GATUS_GROUP', value: 'core' },
  ]);
  // Nothing is published for devices not added.
  assert.equal(world.fake.states.length, 0);
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('the states of an added device, at once, then only the changes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const ids = idsOf(world, 'Website');
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), 1);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 12);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.UPTIME_24H)), 100);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.UPTIME_7D)), 99.86);
  const instance = instanceIds(world.gladys);
  assert.equal(world.fake.lastState(instance.feature(INSTANCE_KEYS.TOTAL)), 4);
  assert.equal(world.fake.lastState(instance.feature(INSTANCE_KEYS.DOWN)), 0);
  assert.deepEqual([...new Set(world.fake.transports.map((entry) => entry.transport))], ['local']);

  const before = world.fake.states.length;
  await world.hub.pollNow();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');
});

test('the response time goes at most every 5 minutes, a change of state at once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const ids = idsOf(world, 'API');
  world.gatus.get('API').results.push(result(true, { duration: 40_000_000 }));
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 12);
  world.clock.advance(4 * MINUTE);
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 40);
  world.gatus.push('API', false);
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), 0);
  assert.equal(world.fake.lastState(instanceIds(world.gladys).feature(INSTANCE_KEYS.DOWN)), 1);
  // A failed check measures nothing: the last response time stays.
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 40);
});

test('a hundred endpoints read every 30 seconds stay under 300 states per minute', async (t) => {
  const gatus = new FakeGatus({ endpoints: [] });
  for (let i = 0; i < 100; i += 1) {
    gatus.endpoints.push(endpoint(`Service ${i}`, 'lab'));
  }
  const world = await createWorld({ gatus });
  t.after(() => world.app.stop());
  await createDevices(world);
  const perStep = [];
  for (let step = 1; step <= 40; step += 1) {
    for (const item of gatus.endpoints) {
      item.results.push(result(true, { duration: (step % 7) * 1_000_000 + 1_000_000 }));
      // Every uptime changes at each reading of the uptimes.
      item.uptimes['24h'] = 1 - step / 10_000;
      item.uptimes['7d'] = 1 - step / 20_000;
    }
    const before = world.fake.states.length;
    world.clock.advance(30_000);
    await world.hub.pollNow();
    perStep.push(world.fake.states.length - before);
  }
  // Any minute: two readings 30 seconds apart.
  const worst = Math.max(...perStep.slice(1).map((count, i) => count + perStep[i]));
  assert.ok(worst < 150, `${worst} states in a minute`);
});

test('"an endpoint goes down" after the threshold, "is back up" with the outage, for any endpoint', async (t) => {
  const world = await createWorld({ config: { url: BASE, language: 'en' } }); // threshold 2
  t.after(() => world.app.stop());
  world.gatus.push('NAS', false);
  await world.hub.pollNow();
  assert.deepEqual(world.fake.sceneEvents, [], 'one failure is not enough');
  world.clock.advance(MINUTE);
  world.gatus.push('NAS', false);
  await world.hub.pollNow();
  world.clock.advance(90 * MINUTE);
  world.gatus.push('NAS', true);
  await world.hub.pollNow();
  const device = idsOf(world, 'NAS').device;
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => [event.key, event.data.device, event.data.endpoint]),
    [
      [TRIGGERS.DOWN, device, 'NAS'],
      [TRIGGERS.UP, device, 'NAS'],
    ],
  );
  assert.equal(events(world, TRIGGERS.DOWN)[0].data.group, 'home');
  assert.equal(events(world, TRIGGERS.DOWN)[0].data.error, '[STATUS] (503) == 200');
  // Counted from the first failed result (10:00), not from its detection.
  assert.equal(events(world, TRIGGERS.UP)[0].data.downtime_minutes, 91);
});

test('no event at the first read, nor for an endpoint without result yet', async (t) => {
  const gatus = new FakeGatus();
  gatus.push('NAS', false);
  gatus.endpoints.push(endpoint('New', 'lab', { results: [] }));
  const world = await createWorld({ gatus });
  t.after(() => world.app.stop());
  await world.hub.pollNow();
  // Its first result settles its state, without event.
  gatus.get('New').results.push(result(true));
  await world.hub.pollNow();
  assert.deepEqual(world.fake.sceneEvents, []);
  gatus.get('New').results.push(result(false));
  await world.hub.pollNow();
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => e.key),
    [TRIGGERS.DOWN],
  );
});

test('an endpoint that went down during a restart is announced once, the outage counted from before', async (t) => {
  const clock = createClock();
  const first = await createWorld({ clock });
  await first.app.stop();
  first.gatus.push('NAS', false);
  const second = await createWorld({ clock, gatus: first.gatus, dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.sceneEvents.map((e) => e.key),
    [TRIGGERS.DOWN],
  );
  await second.app.stop();
  clock.advance(10 * MINUTE);
  first.gatus.push('NAS', true);
  const third = await createWorld({ clock, gatus: first.gatus, dataDir: first.dataDir });
  t.after(() => third.app.stop());
  assert.deepEqual(
    third.fake.sceneEvents.map((e) => [e.key, e.data.downtime_minutes]),
    [[TRIGGERS.UP, 10]],
  );
});

test('Gatus restarted: an endpoint missing from one answer keeps its outage, forgotten after a day', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.gatus.push('NAS', false);
  await world.hub.pollNow();
  const nas = world.gatus.endpoints.splice(2, 1)[0];
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  world.gatus.endpoints.push(nas);
  nas.results = [result(true)];
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => e.key),
    [TRIGGERS.DOWN, TRIGGERS.UP],
  );
  world.gatus.endpoints.pop();
  await world.hub.pollNow();
  world.clock.advance(24 * 3600_000);
  await world.hub.pollNow();
  assert.equal(world.hub.saved.endpoints[nas.key], undefined);
});

test('another Gatus address: the states saved for the previous one are dropped', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.gatus.push('NAS', false);
  await world.hub.pollNow();
  // The other server has a "home/NAS" too, up: not a recovery of the first one.
  world.gatus.push('NAS', true);
  await world.fake.configUpdated({ url: 'http://192.0.2.11:8080', language: 'en' });
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => e.key),
    [TRIGGERS.DOWN],
  );
});

test('Gatus unreachable: status, badges, one warning, no endpoint event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.gatus.failure = 'down';
  const lines = await captureLogs(t, 'info', async () => {
    await world.hub.pollNow();
    await world.hub.pollNow();
    await world.hub.pollNow();
  });
  assert.equal(lines.length, 1, 'one line for an outage, not one per read');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(world.fake.connectionStatus.message.en, 'Gatus does not answer');
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(world.fake.sceneEvents, []);
  world.gatus.failure = null;
  await world.hub.pollNow();
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('basic login: refused or missing is reported, right is read; no address says what to do', async (t) => {
  const gatus = new FakeGatus({ username: 'gladys', password: 'pw' });
  const bad = await createWorld({
    gatus,
    config: { url: BASE, username: 'gladys', password: 'nope', language: 'fr' },
  });
  t.after(() => bad.app.stop());
  assert.equal(bad.fake.connectionStatus.connected, false);
  assert.match(bad.fake.connectionStatus.message.fr, /Gatus demande une connexion/);
  const good = await createWorld({
    gatus,
    config: { url: BASE, username: 'gladys', password: 'pw' },
  });
  t.after(() => good.app.stop());
  assert.equal(good.fake.connectionStatus.connected, true);
  assert.equal(good.fake.discoveredDevices.length, 5);
  const none = await createWorld({ config: {} });
  t.after(() => none.app.stop());
  assert.equal(none.fake.connectionStatus.connected, false);
  assert.match(none.fake.connectionStatus.message.en, /Enter the address/);
  assert.equal(none.gatus.requests.length, 0);
  assert.deepEqual(none.fake.discoveredDevices, []);
  const wrong = await createWorld({ config: { url: 'ftp://x' } });
  t.after(() => wrong.app.stop());
  assert.match(wrong.fake.connectionStatus.message.en, /Address not understood/);
  const widget = await wrong.fake.widgetGet(WIDGET_KEY, { language: 'en' });
  assert.match(widget.data.content.components[0].text, /Address not understood/);
});

test('the uptimes are read every 5 minutes, and kept when a reading fails', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const uptimeReads = () => world.gatus.requests.filter((r) => r.url.includes('/uptimes/')).length;
  assert.equal(uptimeReads(), 8, 'two periods of four endpoints');
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  assert.equal(uptimeReads(), 8);
  world.gatus.get('Website').uptimes['24h'] = 0.9875;
  world.gatus.get('API').key = 'core_api-renamed-in-the-fake'; // its uptime now answers 404
  world.clock.advance(5 * MINUTE);
  world.gatus.get('API').key = 'core_api';
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(idsOf(world, 'Website').feature('uptime_24h')), 98.75);
  assert.equal(world.fake.lastState(idsOf(world, 'API').feature('uptime_24h')), 100);
});

test('"State of an endpoint" and "Count the endpoints down", in the language of the configuration', async (t) => {
  const gatus = new FakeGatus();
  gatus.push('NAS', false);
  gatus.get('NAS').uptimes['24h'] = 0.975;
  const world = await createWorld({
    gatus,
    config: { url: BASE, language: 'fr', failure_threshold: '1' },
  });
  t.after(() => world.app.stop());
  const nas = await world.fake.sceneAction('get_endpoint_status', {
    device: idsOf(world, 'NAS').device,
  });
  assert.equal(nas.success, true, nas.error);
  assert.deepEqual(nas.data.outputs, {
    online: false,
    state: 'En panne',
    name: 'NAS',
    group: 'home',
    response_time: 0,
    uptime_24h: 97.5,
    error: '[STATUS] (503) == 200',
    sentence: 'NAS : En panne, 97,5 % sur 24 h. [STATUS] (503) == 200',
  });
  const website = await world.fake.sceneAction('get_endpoint_status', {
    device: idsOf(world, 'Website').device,
  });
  assert.equal(website.data.outputs.sentence, 'Website : En ligne, 12 ms, 100 % sur 24 h.');
  const count = await world.fake.sceneAction('count_down_endpoints', {});
  assert.deepEqual(count.data.outputs, { down: 1, total: 4, names: 'NAS' });
  const core = await world.fake.sceneAction('count_down_endpoints', { group: ' Core ' });
  assert.deepEqual(core.data.outputs, { down: 0, total: 2, names: '' });
  const unknown = await world.fake.sceneAction('get_endpoint_status', { device: 'nope' });
  assert.match(unknown.error, /pas un point d'accès Gatus/);
  // An error of an older reading: the actions read Gatus again.
  world.gatus.failure = 'down';
  await world.hub.pollNow();
  world.gatus.failure = null;
  world.clock.advance(MINUTE);
  const again = await world.fake.sceneAction('count_down_endpoints', {});
  assert.equal(again.success, true, again.error);
});

test('"Push a result": by key or name, the token of the configuration, read once the Gatus cache expired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({
    timers: true,
    config: { url: BASE, language: 'en', failure_threshold: '1', external_token: TOKEN },
  });
  t.after(() => world.app.stop());
  const ok = await world.fake.sceneAction('push_external_result', {
    endpoint: 'jobs_backups',
    result: 'success',
  });
  assert.equal(ok.success, true, ok.error);
  const failed = await world.fake.sceneAction('push_external_result', {
    endpoint: 'backups',
    result: 'failure',
    error: 'disk full',
  });
  assert.equal(failed.success, true, failed.error);
  assert.deepEqual(world.gatus.get('Backups').results.at(-1).errors, ['disk full']);
  // Gatus caches its answer 10 s: the next read comes 11 s after the push.
  assert.deepEqual(world.fake.sceneEvents, []);
  t.mock.timers.tick(11_000);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => [e.key, e.data.endpoint, e.data.error]),
    [[TRIGGERS.DOWN, 'Backups', 'disk full']],
  );
  const missing = await world.fake.sceneAction('push_external_result', {
    endpoint: 'core_api',
    result: 'success',
  });
  assert.match(missing.error, /no external endpoint with this key/);
  world.gatus.endpoints.push(endpoint('Backups', 'other'));
  world.clock.advance(MINUTE);
  await world.hub.pollNow();
  const ambiguous = await world.fake.sceneAction('push_external_result', {
    endpoint: 'Backups',
    result: 'success',
  });
  assert.match(ambiguous.error, /Several endpoints have this name/);
  await world.fake.configUpdated({ url: BASE, language: 'en', external_token: 'wrong' });
  const refused = await world.fake.sceneAction('push_external_result', {
    endpoint: 'jobs_backups',
    result: 'success',
  });
  assert.match(refused.error, /token refused/);
  await world.fake.configUpdated({ url: BASE, language: 'en' });
  const noToken = await world.fake.sceneAction('push_external_result', {
    endpoint: 'jobs_backups',
    result: 'success',
  });
  assert.match(noToken.error, /Enter the token/);
});

test('the widget: endpoints down first, with group, response time and uptime; a Refresh button', async (t) => {
  const gatus = new FakeGatus();
  gatus.push('NAS', false);
  const world = await createWorld({ gatus });
  t.after(() => world.app.stop());
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'en' });
  assert.equal(ack.success, true, ack.error);
  validateWidgetContent(ack.data.content);
  const { components } = ack.data.content;
  assert.deepEqual(
    components.filter((c) => c.type === 'value').map((c) => [c.label, c.value]),
    [
      ['Down', 1],
      ['Up', 3],
      ['Uptime 24 h', 100],
    ],
  );
  const rows = components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['home · NAS', 'Down · 100 %'],
      ['core · API', '12 ms · 100 %'],
      ['core · Website', '12 ms · 100 %'],
      ['jobs · Backups', '12 ms · 100 %'],
    ],
  );
  assert.equal(components.at(-1).action.key, 'refresh');
  const refreshed = await world.fake.widgetAction(WIDGET_KEY, 'refresh');
  assert.equal(refreshed.success, true);

  const group = await world.fake.widgetGet(WIDGET_KEY, { settings: { group: 'Core' } });
  assert.deepEqual(
    group.data.content.components.find((c) => c.type === 'status').items.map((r) => r.label),
    ['core · API', 'core · Website'],
  );
  const chosen = await world.fake.widgetGet(WIDGET_KEY, {
    settings: { group: 'core', endpoints: [idsOf(world, 'NAS').device] },
  });
  assert.deepEqual(
    chosen.data.content.components.find((c) => c.type === 'status').items.map((r) => r.label),
    ['home · NAS'],
  );
  const nothing = await world.fake.widgetGet(WIDGET_KEY, { settings: { group: 'nope' } });
  assert.match(nothing.data.content.components[0].text, /No endpoint to show/);
});

test('the widget folds more than ten endpoints into one row per group', async (t) => {
  const gatus = new FakeGatus({ endpoints: [] });
  for (let i = 0; i < 8; i += 1) {
    gatus.endpoints.push(endpoint(`Web ${i}`, 'web'));
    gatus.endpoints.push(endpoint(`Db ${i}`, 'databases'));
  }
  gatus.endpoints.push(endpoint('Lonely', ''));
  gatus.push('Db 3', false);
  const world = await createWorld({ gatus });
  t.after(() => world.app.stop());
  const ack = await world.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  validateWidgetContent(ack.data.content);
  assert.deepEqual(
    ack.data.content.components
      .find((c) => c.type === 'status')
      .items.map((r) => [r.label, r.value]),
    [
      ['databases', 'En panne : 1 / 8'],
      ['Sans groupe', 'En ligne : 1 / 1'],
      ['web', 'En ligne : 8 / 8'],
    ],
  );
});

test('the widget says what to do without address, and when Gatus does not answer', async (t) => {
  const none = await createWorld({ config: {} });
  t.after(() => none.app.stop());
  const empty = await none.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  assert.match(empty.data.content.components[0].text, /Saisissez l'adresse/);
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.gatus.failure = 'down';
  await world.hub.pollNow();
  const toast = await world.fake.widgetAction(WIDGET_KEY, 'refresh');
  assert.equal(toast.data?.message?.en ?? toast.data?.en, 'Gatus does not answer');
  const ack = await world.fake.widgetGet(WIDGET_KEY, { language: 'en' });
  assert.ok(ack.data.content.components.some((c) => c.text === 'Gatus does not answer'));
});

test('a device added later gets its states at once, and the widget refreshes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const refreshes = world.fake.widgetRefreshes.length;
  await createDevices(world, (device) => device.name === 'NAS');
  assert.equal(world.fake.lastState(idsOf(world, 'NAS').feature('online')), 1);
  assert.equal(world.fake.lastState(idsOf(world, 'NAS').feature('uptime_7d')), 99.86);
  assert.ok(world.fake.widgetRefreshes.length > refreshes);
});

test('a new language renames the devices proposed; an endpoint removed from Gatus leaves', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ url: BASE, language: 'de' });
  assert.ok(
    world.fake.discoveredDevices[1].features.some((f) => f.name === 'Antwortzeit'),
    'German names',
  );
  world.gatus.endpoints.pop();
  await world.hub.pollNow();
  assert.equal(world.fake.discoveredDevices.length, 4);
});

test('the state file is written only when something changed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const saves = t.mock.method(world.hub.store, 'save');
  await world.hub.pollNow();
  await world.hub.pollNow();
  assert.equal(saves.mock.callCount(), 0);
  world.gatus.push('NAS', false);
  await world.hub.pollNow();
  assert.equal(saves.mock.callCount(), 1);
});

test('Gladys restarted: everything is sent again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const before = world.fake.states.length;
  await world.hub.resync(world.hub.config);
  assert.ok(world.fake.states.length > before);
});

test('"Test the connection" reads Gatus and reports in the four languages', async (t) => {
  const gatus = new FakeGatus();
  gatus.push('NAS', false);
  const world = await createWorld({ gatus });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'Gatus: Connected, 4 endpoint(s), 1 down');
  assert.equal(ack.data.message.fr, "Gatus : Connecté, 4 point(s) d'accès, 1 en panne");
  world.gatus.failure = 401;
  const refused = await world.fake.action('test_connection');
  assert.match(refused.data.message.de, /Gatus verlangt eine Anmeldung/);
});

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('a normal reading cycle writes nothing at the info level', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const sent = world.fake.states.length;
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      world.gatus.get('API').results.push(result(true, { duration: (cycle + 2) * 1_000_000 }));
      world.gatus.get('API').uptimes['24h'] = 1 - cycle / 1000;
      world.clock.advance(5 * MINUTE);
      await world.hub.pollNow();
    }
  });
  assert.ok(world.fake.states.length > sent, 'states were published');
  assert.deepEqual(lines, []);
});

test('the internal timer reads Gatus and publishes the changes, without any poll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const reads = world.gatus.requests.length;
  world.gatus.push('NAS', false);
  t.mock.timers.tick(60_000);
  // Let the read and the publications settle.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(world.gatus.requests.length > reads);
  assert.equal(world.fake.lastState(idsOf(world, 'NAS').feature('online')), 0);
});
