const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const videoClient = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');

const originalListConfigs = aiConfigService.listConfigs;
const originalFetch = global.fetch;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function gatewayConfig(overrides = {}) {
  return {
    id: 1,
    service_type: 'video',
    is_active: true,
    is_default: true,
    provider: 'minimax_h3_gateway',
    api_protocol: 'minimax_h3_gateway',
    base_url: 'http://127.0.0.1:3425/v1',
    api_key: 'magpie-test-key',
    model: ['minimax-h3-local/minimax-h3-original'],
    default_model: 'minimax-h3-local/minimax-h3-original',
    endpoint: '/videos',
    query_endpoint: '/videos/{taskId}',
    ...overrides,
  };
}

describe('minimax_h3_gateway protocol', () => {
  afterEach(() => {
    aiConfigService.listConfigs = originalListConfigs;
    global.fetch = originalFetch;
  });

  it('is not inferred as the official minimax_h3 protocol', () => {
    assert.equal(
      videoClient.resolveVideoProtocol(
        { ...gatewayConfig(), api_protocol: '' },
        'minimax-h3-original'
      ),
      'minimax_h3_gateway'
    );
    assert.equal(
      videoClient.resolveVideoProtocol(
        { provider: 'minimax_h3', api_protocol: '', base_url: 'https://api.minimaxi.com' },
        'MiniMax-H3'
      ),
      'minimax_h3'
    );
  });

  it('builds submit, poll and content URLs from the gateway base', () => {
    const config = gatewayConfig();
    assert.equal(
      videoClient.buildMinimaxH3GatewayUrl(config),
      'http://127.0.0.1:3425/v1/videos'
    );
    assert.equal(
      videoClient.buildMinimaxH3GatewayPollUrl(config, 'video_abc.1'),
      'http://127.0.0.1:3425/v1/videos/video_abc.1'
    );
    assert.equal(
      videoClient.buildMinimaxH3GatewayContentUrl(config, 'video_abc.1'),
      'http://127.0.0.1:3425/v1/videos/video_abc.1/content'
    );
    assert.equal(videoClient.buildMinimaxH3GatewayPollUrl(config, ''), null);
  });

  it('submits only the fields the self-hosted H3 gateway accepts', async () => {
    const config = gatewayConfig();
    aiConfigService.listConfigs = () => [config];
    let sentBody = null;
    global.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:3425/v1/videos');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer magpie-test-key');
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'video_minimax-h3-local.demo',
            object: 'video',
            status: 'queued',
            model: 'minimax-h3-local/minimax-h3-original',
          }),
      };
    };

    const result = await videoClient.callVideoApi(null, noopLog, {
      prompt: 'a red ball rolling slowly on a table',
      model: 'minimax-h3-local/minimax-h3-original',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
      seed: 7,
      video_gen_id: 1,
    });

    // no references means the standard tier, which only renders five seconds
    assert.deepEqual(Object.keys(sentBody).sort(), ['model', 'prompt', 'seconds', 'seed', 'size']);
    assert.equal(sentBody.seconds, '5');
    assert.equal(sentBody.size, '1024x576');
    assert.equal(sentBody.seed, 7);
    assert.equal(result.task_id, 'video_minimax-h3-local.demo');
    assert.equal(result.status, 'queued');
  });

  it('sends up to nine references as reference_images and one as a first frame', async () => {
    const config = gatewayConfig();
    aiConfigService.listConfigs = () => [config];
    const sent = [];
    global.fetch = async (url, init) => {
      if (init && init.method === 'POST') sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'video_demo', object: 'video', status: 'queued' }),
      };
    };

    const dataUri = (label) => 'data:image/png;base64,' + Buffer.from(label).toString('base64');

    await videoClient.callVideoApi(null, noopLog, {
      prompt: 'several assets in a room',
      model: 'minimax-h3-local/minimax-h3-original',
      reference_urls: [dataUri('scene'), dataUri('hero'), dataUri('prop')],
      duration: 16,
      aspect_ratio: '9:16',
      video_gen_id: 2,
    });
    assert.equal(sent[0].reference_images.length, 3);
    assert.equal(sent[0].image, undefined);
    // multi reference goes to ref2va, which renders up to fifteen seconds
    assert.equal(sent[0].seconds, '15');
    assert.equal(sent[0].size, '576x1024');

    await videoClient.callVideoApi(null, noopLog, {
      prompt: 'more assets than ref2va accepts',
      model: 'minimax-h3-local/minimax-h3-original',
      reference_urls: Array.from({ length: 12 }, (_, i) => dataUri('asset' + i)),
      video_gen_id: 4,
    });
    assert.equal(sent[1].reference_images.length, 9);

    await videoClient.callVideoApi(null, noopLog, {
      prompt: 'one character in a room',
      model: 'minimax-h3-local/minimax-h3-original',
      reference_urls: [dataUri('hero')],
      video_gen_id: 3,
    });
    assert.equal(sent[2].image.startsWith('data:image/png;base64,'), true);
    assert.equal(sent[2].reference_images, undefined);
  });

  it('backs off and resubmits while the gateway queue is full', async () => {
    const config = gatewayConfig();
    aiConfigService.listConfigs = () => [config];
    let posts = 0;
    const seenRetryAfter = [];
    global.fetch = async (url, init) => {
      if (init && init.method === 'POST') posts += 1;
      if (posts < 3) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '1' : null) },
          text: async () => JSON.stringify({ error: 'queue is full' }),
        };
      }
      return {
        ok: true,
        status: 202,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: 'video_demo', object: 'video', status: 'queued' }),
      };
    };

    const result = await videoClient.callVideoApi(null, {
      info() {}, debug() {}, error() {},
      warn(_msg, meta) { if (meta && meta.wait_ms != null) seenRetryAfter.push(meta.wait_ms); },
    }, {
      prompt: 'a cat on a sofa',
      model: 'minimax-h3-local/minimax-h3-original',
      reference_urls: ['data:image/png;base64,' + Buffer.from('scene').toString('base64'),
                       'data:image/png;base64,' + Buffer.from('hero').toString('base64')],
      video_gen_id: 5,
    });

    assert.equal(posts, 3);
    assert.deepEqual(seenRetryAfter, [1000, 1000]);
    assert.equal(result.task_id, 'video_demo');
    assert.equal(result.error, undefined);
  });

  it('honours Retry-After and falls back to 30s when it is absent', () => {
    const MAX = 60000;
    assert.equal(videoClient.gatewayRetryAfterMs('30', MAX), 30000);
    // magpie strips the header, so an empty value must not collapse to the floor
    assert.equal(videoClient.gatewayRetryAfterMs('', MAX), 30000);
    assert.equal(videoClient.gatewayRetryAfterMs(null, MAX), 30000);
    assert.equal(videoClient.gatewayRetryAfterMs(undefined, MAX), 30000);
    assert.equal(videoClient.gatewayRetryAfterMs('90', MAX), MAX);
    assert.equal(videoClient.gatewayRetryAfterMs('0', MAX), 1000);
    assert.equal(videoClient.gatewayRetryAfterMs('garbage', MAX), 30000);
  });
});
