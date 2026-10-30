// The fake website API the e2e run renders /download against (started by playwright.config.ts).
import { startFakeReleaseApi } from '../tests/helpers/fakeReleaseApi';

const api = await startFakeReleaseApi({ port: Number(process.env.FAKE_API_PORT || 4339) });
console.log(`Fake release API listening on ${api.url}`);
