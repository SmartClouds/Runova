// The fake website API the e2e run renders /download, the blog and the news against (started by
// playwright.config.ts).
import { once } from 'node:events';
import { createServer } from 'node:http';
import { handleBlogRequest } from '../tests/helpers/fakeBlogApi';
import { handleNewsRequest } from '../tests/helpers/fakeNewsApi';
import { handleReleaseRequest } from '../tests/helpers/fakeReleaseApi';

const port = Number(process.env.FAKE_API_PORT || 4339);
const server = createServer((request, reply) => {
  if (
    handleReleaseRequest(request, reply) ||
    handleBlogRequest(request, reply) ||
    handleNewsRequest(request, reply)
  ) {
    return;
  }
  reply.writeHead(404, { 'content-type': 'application/problem+json' });
  reply.end(JSON.stringify({ status: 404, title: 'Not found.' }));
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');
console.log(`Fake website API listening on http://127.0.0.1:${port}`);
