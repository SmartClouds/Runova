/** The post editor's form, and how it maps to the API's `PostAdminDto` and `PostWriteDto`. */

import {
  type ItemStatus,
  NEW_PUBLISHING,
  type Publishing,
  publishingFields,
  publishingFrom,
  splitList,
} from './publishing';

export interface Cover {
  url: string;
  alt: string;
}

/** A `PostAdminDto` from the API contract, as far as the editor reads it. */
export interface PostAdmin {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  coverImage: (Cover & { width: number; height: number }) | null;
  tags: { slug: string; name: string }[];
  publishedAt: string | null;
  bodyMarkdown: string;
  status: ItemStatus;
  version: string;
}

/** A `MediaDto` from `POST /api/v1/media`. */
export interface Media {
  id: number;
  url: string;
  width: number;
  height: number;
  alt: string;
}

export interface PostForm {
  title: string;
  slug: string;
  slugEdited: boolean;
  excerpt: string;
  /** Tag names as typed, separated by commas. */
  tags: string;
  bodyMarkdown: string;
  cover: Cover | null;
  /**
   * The cover's media id once the editor uploads or removes one (null). It stays undefined while
   * the cover is the saved one, because `PostAdminDto` does not say which media that is.
   */
  coverMediaId?: number | null;
  publishing: Publishing;
}

export const NEW_POST_FORM: PostForm = {
  title: '',
  slug: '',
  slugEdited: false,
  excerpt: '',
  tags: '',
  bodyMarkdown: '',
  cover: null,
  publishing: NEW_PUBLISHING,
};

export function postFormFrom(post: PostAdmin): PostForm {
  return {
    title: post.title,
    slug: post.slug,
    slugEdited: true,
    excerpt: post.excerpt,
    tags: post.tags.map((tag) => tag.name).join(', '),
    bodyMarkdown: post.bodyMarkdown,
    cover: post.coverImage && { url: post.coverImage.url, alt: post.coverImage.alt },
    publishing: publishingFrom(post.status, post.publishedAt),
  };
}

/**
 * The body of a post save: the `PostWriteDto` of a new post, or the merge patch of an existing
 * one. Both leave `coverMediaId` out unless the cover changed, which keeps the saved cover.
 */
export function postWriteDto(form: PostForm) {
  return {
    slug: form.slug,
    title: form.title,
    excerpt: form.excerpt,
    bodyMarkdown: form.bodyMarkdown,
    ...(form.coverMediaId !== undefined && { coverMediaId: form.coverMediaId }),
    tags: splitList(form.tags, /[,\n]/),
    ...publishingFields(form.publishing),
  };
}
