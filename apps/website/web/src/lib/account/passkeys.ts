/**
 * Passkeys (E115) in the browser: a challenge from the API, the browser's passkey prompt, and the
 * answer in the JSON form the API reads (PublicKeyCredential.toJSON). Browsers that parse and
 * write that JSON themselves do; for the rest the conversions below do the same work.
 */
import { apiRequest } from './api';

export type PasskeyPurpose = 'sign-in' | 'register' | 'step-up';

interface PasskeyChallenge {
  id: string;
  options: Record<string, unknown>;
  expiresAt: string;
}

export type PasskeyCeremony =
  | { ok: true; challengeId: string; credential: Record<string, unknown> }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

type Json = Record<string, unknown>;

interface CredentialDescriptorJson {
  id: string;
  type: string;
  transports?: string[];
}

interface PublicKeyCredentialStatics {
  parseRequestOptionsFromJSON?: (options: Json) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (options: Json) => PublicKeyCredentialCreationOptions;
}

const BROKEN = 'This browser could not use a passkey just now. Try again, or sign in another way.';

export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

export function toBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const view =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const descriptors = (list: unknown): PublicKeyCredentialDescriptor[] | undefined =>
  Array.isArray(list)
    ? (list as CredentialDescriptorJson[]).map((item) => ({
        ...item,
        type: 'public-key',
        id: fromBase64Url(item.id).buffer,
        transports: item.transports as AuthenticatorTransport[] | undefined,
      }))
    : undefined;

/** `PublicKeyCredentialRequestOptions` from the API's JSON. */
export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64Url(json.challenge as string).buffer,
    allowCredentials: descriptors(json.allowCredentials),
  };
}

/** `PublicKeyCredentialCreationOptions` from the API's JSON. */
export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as { id: string; name: string; displayName: string };
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64Url(json.challenge as string).buffer,
    user: { ...user, id: fromBase64Url(user.id).buffer },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** The browser's answer as PublicKeyCredential.toJSON writes it. */
export function credentialJson(credential: PublicKeyCredential): Json {
  // Older browsers have no toJSON, though the DOM types say every credential does.
  const toJson = (credential as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === 'function') return toJson.call(credential) as Json;
  const response = credential.response as AuthenticatorResponse &
    Partial<AuthenticatorAssertionResponse & AuthenticatorAttestationResponse>;
  const body: Json = { clientDataJSON: toBase64Url(response.clientDataJSON) };
  if (response.attestationObject) {
    body.attestationObject = toBase64Url(response.attestationObject);
    body.transports = response.getTransports?.() ?? [];
  } else {
    body.authenticatorData = toBase64Url(response.authenticatorData as ArrayBuffer);
    body.signature = toBase64Url(response.signature as ArrayBuffer);
    body.userHandle = response.userHandle ? toBase64Url(response.userHandle) : null;
  }
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: body,
  };
}

/**
 * One passkey ceremony: asks the API for a challenge, shows the browser's prompt, and hands back
 * the challenge id and the answer for the call that needs them. Closing the prompt is
 * `cancelled`, which callers show nothing for.
 */
export async function runPasskey(purpose: PasskeyPurpose): Promise<PasskeyCeremony> {
  const challenge = await apiRequest<PasskeyChallenge>('/passkey-challenges', {
    method: 'POST',
    body: { purpose },
  });
  if (!challenge.ok) {
    return {
      ok: false,
      cancelled: false,
      message: challenge.problem.detail || challenge.problem.title,
    };
  }
  const { id, options } = challenge.value;
  const statics = window.PublicKeyCredential as unknown as PublicKeyCredentialStatics;
  try {
    const credential =
      purpose === 'register'
        ? await navigator.credentials.create({
            publicKey: statics.parseCreationOptionsFromJSON?.(options) ?? creationOptions(options),
          })
        : await navigator.credentials.get({
            publicKey: statics.parseRequestOptionsFromJSON?.(options) ?? requestOptions(options),
          });
    if (!credential) return { ok: false, cancelled: true };
    return {
      ok: true,
      challengeId: id,
      credential: credentialJson(credential as PublicKeyCredential),
    };
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'AbortError')
    ) {
      return { ok: false, cancelled: true };
    }
    return { ok: false, cancelled: false, message: BROKEN };
  }
}
