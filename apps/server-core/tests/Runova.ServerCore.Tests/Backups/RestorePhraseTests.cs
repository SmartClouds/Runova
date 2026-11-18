using Runova.ServerCore.Backups;
using Runova.ServerCore.Cli;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// A backup made with a recovery phrase (E107) is sealed with the phrase in its one form, lowercase
/// words with single spaces. Typed at the admin CLI with capitals or extra spaces, it still opens.
/// The file here is sealed but holds no archive, so getting past the passphrase shows as the
/// archive being refused instead.
/// </summary>
public sealed class RestorePhraseTests : IDisposable
{
    private const string Phrase =
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

    private const string WrongPassphrase = "The passphrase is wrong, or the backup file is damaged.";

    private readonly string _server = Path.Combine(Path.GetTempPath(), $"core-phrase-{Guid.NewGuid():N}");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public void Dispose() => TestFolders.Delete(_server);

    private async Task<string> RestoreAsync(string typed)
    {
        Directory.CreateDirectory(_server);
        var file = Path.Combine(_server, "upload.rnbackup");
        await using (var output = File.Create(file))
        {
            await BackupCrypto.EncryptAsync(new MemoryStream([1, 2, 3]), output, Phrase, 42, Cancel);
        }

        using var error = new StringWriter();
        await AdminCli.RunAsync(
            ["restore-stage", "--file", file, "--into", Path.Combine(_server, $"stage-{Guid.NewGuid():N}"), "--passphrase-stdin"],
            new StringReader(typed + "\n"),
            new StringWriter(),
            error,
            () => new AdminEnvironment(_server, TimeProvider.System, 1000, "deployer"));
        return error.ToString();
    }

    [Fact]
    public async Task A_phrase_typed_with_capitals_and_extra_spaces_opens_the_backup()
    {
        var error = await RestoreAsync("  " + Phrase.ToUpperInvariant().Replace(" ", "   ", StringComparison.Ordinal) + " ");

        Assert.DoesNotContain(WrongPassphrase, error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_phrase_with_a_wrong_word_does_not()
    {
        var error = await RestoreAsync(Phrase.Replace("title", "zoo", StringComparison.Ordinal));

        Assert.Contains(WrongPassphrase, error, StringComparison.Ordinal);
    }
}
