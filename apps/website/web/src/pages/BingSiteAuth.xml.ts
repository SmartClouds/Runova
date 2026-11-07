import type { APIRoute } from 'astro';
import { bingVerificationFile } from '../lib/siteVerification';

// Bing Webmaster Tools' verification file (E59).
export const prerender = false;

export const GET: APIRoute = () => bingVerificationFile();
