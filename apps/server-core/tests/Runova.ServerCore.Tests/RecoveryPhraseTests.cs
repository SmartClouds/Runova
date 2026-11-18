using System.Text.Json;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Recovery phrases (E107), against the vectors the desktop and the phone core replay, so a phrase
/// made on the desktop is read the same here.
/// </summary>
public sealed class RecoveryPhraseTests
{
    private static readonly JsonElement _vectors = JsonElement.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Vectors", "recovery-phrase-v1.json")));

    public static TheoryData<string, string> Entropy()
    {
        var data = new TheoryData<string, string>();
        foreach (var item in _vectors.GetProperty("entropy").EnumerateArray())
        {
            data.Add(item.GetProperty("entropy").GetString()!, item.GetProperty("phrase").GetString()!);
        }

        return data;
    }

    public static TheoryData<string, string, bool> Canonical()
    {
        var data = new TheoryData<string, string, bool>();
        foreach (var item in _vectors.GetProperty("canonical").EnumerateArray())
        {
            data.Add(
                item.GetProperty("input").GetString()!,
                item.GetProperty("output").GetString()!,
                item.GetProperty("isPhrase").GetBoolean());
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Entropy))]
    public void Reads_the_bytes_behind_each_vector_phrase(string entropy, string phrase)
    {
        Assert.Equal(entropy, Convert.ToHexStringLower(RecoveryPhrase.ToEntropy(phrase)!));
        Assert.True(RecoveryPhrase.IsValid(phrase));
    }

    [Theory]
    [MemberData(nameof(Canonical))]
    public void Writes_a_phrase_one_way_and_leaves_a_passphrase_as_typed(string input, string output, bool isPhrase)
    {
        Assert.Equal(output, RecoveryPhrase.Canonicalize(input));
        Assert.Equal(isPhrase, RecoveryPhrase.IsValid(input));
    }

    [Fact]
    public void Gives_nothing_for_text_that_is_not_a_phrase()
    {
        Assert.Null(RecoveryPhrase.ToEntropy("orange tractor bicycle lamp"));
        Assert.Equal(string.Empty, RecoveryPhrase.Canonicalize(string.Empty));
    }
}
