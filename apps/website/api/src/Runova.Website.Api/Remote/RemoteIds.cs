using System.Globalization;
using System.Security.Cryptography;

namespace Runova.Website.Api.Remote;

/// <summary>
/// Runova IDs (E60): nine digits that never start with 0, picked at random so one ID says
/// nothing about another, and shown as "482 193 775".
/// </summary>
internal static class RemoteIds
{
    public const int Length = 9;

    public static string New() => RandomNumberGenerator.GetInt32(100_000_000, 1_000_000_000).ToString(CultureInfo.InvariantCulture);

    /// <summary>The ID someone typed or pasted, without its spaces and dashes, or null when it is not one.</summary>
    public static string? Parse(string? typed)
    {
        if (typed is null)
        {
            return null;
        }

        Span<char> digits = stackalloc char[Length];
        var count = 0;
        foreach (var c in typed)
        {
            if (c is ' ' or '-' or ' ' or '\t')
            {
                continue;
            }

            if (c is < '0' or > '9' || count == Length)
            {
                return null;
            }

            digits[count++] = c;
        }

        return count == Length && digits[0] != '0' ? new string(digits) : null;
    }

    public static string Format(string id) => $"{id[..3]} {id[3..6]} {id[6..]}";
}
