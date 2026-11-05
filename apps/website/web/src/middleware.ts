import { defineMiddleware } from 'astro:middleware';
import { accountMiddleware } from './lib/account/guard';
import { adminMiddleware } from './lib/admin/guard';

export const onRequest = defineMiddleware((context, next) =>
  adminMiddleware(context, (rewrite) =>
    rewrite ? next(rewrite) : accountMiddleware(context, () => next()),
  ),
);
