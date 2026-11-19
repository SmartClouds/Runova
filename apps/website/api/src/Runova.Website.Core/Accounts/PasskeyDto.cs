using System.Text.Json;

namespace Runova.Website.Core.Accounts;

/// <summary>
/// One of the account's passkeys (E115). The id is the credential id in base64url; the public key
/// and the attestation stay on the server.
/// </summary>
public sealed record PasskeyDto(string Id, string Name, DateTimeOffset CreatedAt, bool Synced);

public sealed record PasskeyListDto(IReadOnlyList<PasskeyDto> Items);

/// <summary>
/// A passkey ceremony to run: the id to send back with the answer, and the WebAuthn options
/// (<c>PublicKeyCredentialCreationOptions</c> or <c>PublicKeyCredentialRequestOptions</c>) as JSON.
/// </summary>
public sealed record PasskeyChallengeDto(string Id, JsonElement Options, DateTimeOffset ExpiresAt);

public sealed record PasskeyChallengeRequest(string? Purpose);

/// <summary>A browser's answer to a <c>sign-in</c> challenge.</summary>
public sealed record PasskeySignInRequest(string? ChallengeId, JsonElement? Credential);

/// <summary>A new passkey: the answer to a <c>register</c> challenge, its name and the step-up proof.</summary>
public sealed record AddPasskeyRequest(
    string? ChallengeId,
    JsonElement? Credential,
    string? Name,
    string? Password,
    string? Code,
    string? PasskeyChallengeId,
    JsonElement? PasskeyCredential);

public sealed record RenamePasskeyRequest(string? Name);
