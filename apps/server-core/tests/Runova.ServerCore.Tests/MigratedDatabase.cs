using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>
/// One core database migrated once per test run, copied into place wherever a test needs a fresh
/// one. Running every migration again for each test host cost about a fifth of a host's start, and
/// with a few thousand of them in parallel that was minutes on CI. The core still prepares the copy
/// as it starts, so the migrations it finds already applied are checked, not skipped.
/// </summary>
internal static class MigratedDatabase
{
    private static readonly Lazy<Task<string>> _template = new(() => Task.Run(CreateTemplateAsync));

    /// <summary>Puts a migrated, empty core database at <paramref name="path"/>, which must not exist yet.</summary>
    /// <remarks>
    /// Blocking is safe here: the template is made on the thread pool (Task.Run),
    /// never on a test's own context, so waiting for it cannot hold up its continuation.
    /// </remarks>
    public static void CopyTo(string path)
    {
        var template = _template.Value.GetAwaiter().GetResult();
        File.Copy(template, path);
        if (File.Exists(template + "-wal"))
        {
            File.Copy(template + "-wal", path + "-wal");
        }

        CoreDatabase.RestrictFiles(path);
    }

    private static async Task<string> CreateTemplateAsync()
    {
        var directory = TestFolders.Create("core-db-template");
        var path = CoreDatabase.PathIn(directory);
        await CoreDatabase.PrepareAsync(path, CancellationToken.None);
        // Closing the last connection checkpoints the write-ahead log into the file, so the file
        // alone is the whole database and a copy of it needs no -wal beside it.
        CoreDatabase.ReleasePool(path);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => TestFolders.Delete(directory);
        return path;
    }
}
