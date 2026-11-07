import type { APIRoute } from 'astro';
import { googleVerificationFile } from '../lib/siteVerification';

// Search Console's HTML verification file, such as /google1234567890abcdef.html (E59).
export const prerender = false;

export const GET: APIRoute = ({ params }) => googleVerificationFile(params.verification ?? '');
