import { defineMiddleware } from 'astro:middleware';
import { adminMiddleware } from './lib/admin/guard';

export const onRequest = defineMiddleware((context, next) =>
  adminMiddleware(context, (rewrite) => (rewrite ? next(rewrite) : next())),
);
