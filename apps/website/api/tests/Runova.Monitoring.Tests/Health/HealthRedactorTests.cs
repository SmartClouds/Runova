using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>
/// A port of redact.test.ts and the maskSecrets cases of security/redact.test.ts. Both directions
/// matter: no secret survives, and ordinary error text stays readable.
/// </summary>
public sealed class HealthRedactorTests
{
    private const string Jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    [Fact]
    public void Masks_the_password_inside_a_connection_url()
    {
        var output = HealthRedactor.Redact("connect failed: postgres://app:S3cretPass@10.0.0.5:5432/app");
        Assert.DoesNotContain("S3cretPass", output, StringComparison.Ordinal);
        Assert.Contains("postgres://app:[redacted]@10.0.0.5:5432/app", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("DB_PASSWORD=hunter22", "hunter22")]
    [InlineData("api_key: abc123xyz", "abc123xyz")]
    [InlineData("\"clientSecret\": \"very-secret-value\"", "very-secret-value")]
    [InlineData("token='tkn_live_9988'", "tkn_live_9988")]
    public void Masks_values_under_secret_looking_names(string text, string secret)
    {
        var output = HealthRedactor.Redact(text);
        Assert.DoesNotContain(secret, output, StringComparison.Ordinal);
        Assert.Contains("[redacted]", output, StringComparison.Ordinal);
    }

    [Fact]
    public void Masks_bearer_and_basic_credentials_in_quoted_headers()
    {
        Assert.Equal("Authorization: Bearer [redacted]", HealthRedactor.Redact("Authorization: Bearer amh_abcdefghijklmnop"));
        Assert.Equal("authorization: Basic [redacted]", HealthRedactor.Redact("authorization: Basic dXNlcjpwYXNz"));
    }

    [Theory]
    [InlineData("rnh_")]
    [InlineData("amh_")]
    public void Masks_a_Runova_health_key_wherever_it_appears(string prefix)
    {
        var key = prefix + new string('Q', 43);
        Assert.DoesNotContain(key, HealthRedactor.Redact($"echoed {key} back"), StringComparison.Ordinal);
    }

    [Fact]
    public void Masks_the_known_token_shapes_and_private_keys()
    {
        const string pem = "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----";
        var output = HealthRedactor.Redact($"jwt {Jwt}\n{pem}");
        Assert.DoesNotContain(Jwt, output, StringComparison.Ordinal);
        Assert.DoesNotContain("MIIEv", output, StringComparison.Ordinal);
    }

    [Fact]
    public void Masks_key_value_pairs_in_a_connection_string()
    {
        var output = HealthRedactor.Redact("Server=db;Database=app;User Id=sa;Password=P@ssw0rd!;TrustServerCertificate=True");
        Assert.DoesNotContain("P@ssw0rd!", output, StringComparison.Ordinal);
        Assert.Contains("Server=db", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("connect ECONNREFUSED 10.0.0.5:5432 after 3 retries (timeout 2000 ms)")]
    [InlineData("The key column was missing from table users")]
    public void Leaves_ordinary_error_text_alone(string text)
    {
        Assert.Equal(text, HealthRedactor.Redact(text));
    }

    [Theory]
    [InlineData("Passing: redis:ping")]
    [InlineData("tokenizer=fast")]
    [InlineData("monkey: 3")]
    [InlineData("https://x.io/a")]
    public void Only_treats_whole_words_as_secret_names(string text)
    {
        Assert.Equal(text, HealthRedactor.Redact(text));
    }

    [Theory]
    [InlineData("authToken=abc123", "authToken=[redacted]")]
    [InlineData("AWS_SECRET_ACCESS_KEY=abcd1234", "AWS_SECRET_ACCESS_KEY=[redacted]")]
    [InlineData("db error: DB_PASSWORD=hunter2 rejected", "db error: DB_PASSWORD=[redacted] rejected")]
    [InlineData("Detail: password=hunter2", "Detail: password=[redacted]")]
    [InlineData("url: https://x.io/a", "url: https://x.io/a")]
    [InlineData("\"detail\": \"password=hunter2\"", "\"detail\": \"password=[redacted]\"")]
    [InlineData("password=[redacted]", "password=[redacted]")]
    // An unclosed quote is read as a bare value, as JavaScript reads it.
    [InlineData("note: \"a=b", "note: \"a=\"")]
    public void Masks_assignments_like_the_TypeScript_port(string text, string expected)
    {
        Assert.Equal(expected, HealthRedactor.Redact(text));
    }

    [Fact]
    public void Masks_values_nested_too_deep_to_follow_whole()
    {
        var text = string.Concat(Enumerable.Repeat("a=", 100_000)) + "password=hunter2";
        var output = HealthRedactor.Redact(text);
        Assert.DoesNotContain("hunter2", output, StringComparison.Ordinal);
        Assert.EndsWith("a=[redacted]", output, StringComparison.Ordinal);
    }

    [Fact]
    public void Follows_a_few_levels_of_nesting_like_the_TypeScript_port()
    {
        Assert.Equal("a: b: c: password=[redacted] done", HealthRedactor.Redact("a: b: c: password=hunter2 done"));
        Assert.Equal("a=b=c=password=[redacted]", HealthRedactor.Redact("a=b=c=password=hunter2"));
    }

    [Fact]
    public void Masks_known_literal_secrets_passed_by_the_caller()
    {
        Assert.Equal("got [redacted]", HealthRedactor.Redact("got hunter2hunter2", ["hunter2hunter2"]));
    }

    [Fact]
    public void Ignores_known_secrets_too_short_to_mask_safely()
    {
        Assert.Equal("the cat sat", HealthRedactor.MaskKnownSecrets("the cat sat", [null, "", "cat", "mat"]));
    }

    [Theory]
    [InlineData("sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("ghp_BBBBBBBBBBBBBBBBBBBBBBBB")]
    [InlineData("xoxb-1234567890-abcdef")]
    [InlineData("AKIAABCDEFGHIJKLMNOP")]
    [InlineData("AIzaSyA-1234567890abcdefghijklmnopqrstu")]
    public void Masks_vendor_prefixed_keys_with_their_length(string secret)
    {
        var output = HealthRedactor.MaskSecrets("value " + secret);
        Assert.Equal($"value [redacted {secret.Length} chars]", output);
    }

    [Fact]
    public void Keeps_the_scheme_of_a_bearer_jwt()
    {
        Assert.Equal($"Authorization: Bearer [redacted {Jwt.Length} chars]", HealthRedactor.MaskSecrets("Authorization: Bearer " + Jwt));
    }

    [Fact]
    public void Masks_a_long_high_entropy_run()
    {
        Assert.Equal("AWS_SECRET_ACCESS_KEY=[redacted 40 chars]", HealthRedactor.MaskSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"));
    }

    [Theory]
    [InlineData("Set your API key in settings")]
    [InlineData("token expired, please log in again")]
    [InlineData("sk-short")]
    [InlineData("AKIAABCDEFGHIJKLMNOPQ")]
    public void Leaves_prose_and_near_misses_alone(string text)
    {
        Assert.Equal(text, HealthRedactor.MaskSecrets(text));
    }

    [Fact]
    public void Reads_word_boundaries_the_way_JavaScript_does()
    {
        // .NET counts letters like e-acute as word characters; JavaScript does not, so the key after
        // it still starts at a word boundary and is masked.
        var key = "rnh_" + new string('Z', 20);
        Assert.Equal("caf" + (char)0xE9 + "[redacted]", HealthRedactor.Redact("caf" + (char)0xE9 + key));
    }

    [Fact]
    public void Counts_a_non_breaking_space_as_space_the_way_JavaScript_does()
    {
        Assert.Equal("Bearer [redacted]", HealthRedactor.Redact("Bearer" + (char)0xA0 + "abcdefgh"));
    }
}
