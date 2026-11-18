using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Runova.ServerCore.Security;

/// <summary>
/// Recovery phrases (E107): 24 BIP39 English words for 32 random bytes, which the Runova app can
/// make in place of a typed backup passphrase or secret key. The desktop sends a phrase in one
/// canonical form, lowercase words with single spaces, and derives nothing from any other form.
/// A phrase typed at the admin CLI goes through <see cref="Canonicalize"/> so it matches however
/// it was typed. Anything that is not exactly 24 list words with a valid checksum is a passphrase
/// and stays as typed. <c>packages/protocol/test-vectors/recovery-phrase-v1.json</c> pins this.
/// </summary>
public static class RecoveryPhrase
{
    public const int WordCount = 24;
    private const int EntropyBytes = 32;

    private static readonly Lazy<Dictionary<string, int>> _words = new(Load);

    /// <summary>The text a key is derived from: a phrase in its one form, anything else as is.</summary>
    public static string Canonicalize(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return TryRead(text, out var phrase, out _) ? phrase : text;
    }

    public static bool IsValid(string text) => TryRead(text, out _, out _);

    /// <summary>The 32 bytes a phrase stands for, or null when the text is not a phrase.</summary>
    public static byte[]? ToEntropy(string text) => TryRead(text, out _, out var entropy) ? entropy : null;

    private static bool TryRead(string text, out string phrase, out byte[] entropy)
    {
        phrase = string.Empty;
        entropy = [];
        var words = FoldWidth(text.Normalize(NormalizationForm.FormKD))
            .ToLowerInvariant()
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length != WordCount)
        {
            return false;
        }

        // 24 words of 11 bits: 256 bits of entropy, then 8 bits of checksum.
        var bits = new BitArrayBuilder(WordCount * 11);
        foreach (var word in words)
        {
            if (!_words.Value.TryGetValue(word, out var index))
            {
                return false;
            }

            bits.Append(index, 11);
        }

        var all = bits.ToBytes();
        var bytes = all[..EntropyBytes];
        if (SHA256.HashData(bytes)[0] != all[EntropyBytes])
        {
            return false;
        }

        phrase = string.Join(' ', words);
        entropy = bytes;
        return true;
    }

    /// <summary>
    /// Full-width letters and the ideographic space as plain ASCII, as NFKD would write them. The
    /// core runs with invariant globalization, where <see cref="string.Normalize()"/> leaves
    /// non-ASCII text alone, and these are what an East Asian keyboard types for the words.
    /// </summary>
    private static string FoldWidth(string text)
    {
        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = chars[i] switch
            {
                >= '！' and <= '～' => (char)(chars[i] - 0xFEE0),
                '　' => ' ',
                _ => chars[i],
            };
        }

        return new string(chars);
    }

    private static Dictionary<string, int> Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Runova.ServerCore.RecoveryPhraseWords")
            ?? throw new InvalidOperationException("The recovery phrase word list is missing from the build.");
        using var reader = new StreamReader(stream);
        var words = new Dictionary<string, int>(StringComparer.Ordinal);
        while (reader.ReadLine() is { } line)
        {
            if (line.Length > 0)
            {
                words.Add(line, words.Count);
            }
        }

        return words.Count == 2048
            ? words
            : throw new InvalidOperationException("The recovery phrase word list must have 2048 words.");
    }

    private sealed class BitArrayBuilder(int capacity)
    {
        private readonly byte[] _bytes = new byte[(capacity + 7) / 8];
        private int _length;

        public void Append(int value, int count)
        {
            for (var bit = count - 1; bit >= 0; bit--)
            {
                if (((value >> bit) & 1) == 1)
                {
                    _bytes[_length / 8] |= (byte)(0x80 >> (_length % 8));
                }

                _length++;
            }
        }

        public byte[] ToBytes() => _bytes;
    }
}
