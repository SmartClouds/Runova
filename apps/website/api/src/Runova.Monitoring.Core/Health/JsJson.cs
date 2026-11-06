using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Runova.Monitoring.Core.Health;

/// <summary>
/// Reads a <see cref="JsonElement"/> the way <c>JSON.parse</c> and JavaScript see it, so the C#
/// parser gives the same answers as the TypeScript one: object keys in JavaScript order (array
/// index keys first, ascending, then the rest as written), the last of a repeated key winning,
/// <c>String(value)</c>, and <c>JSON.stringify(value, null, 2)</c>.
/// </summary>
internal static class JsJson
{
    /// <summary>Deep enough for any real report; JavaScript has no fixed limit.</summary>
    public static readonly JsonDocumentOptions ParseOptions = new() { MaxDepth = 1024 };

    /// <summary>
    /// Parses like <c>JSON.parse</c>, or returns null when the text is not JSON. A string with a
    /// lone surrogate escape is counted as not JSON too, since .NET can not hold it as a string.
    /// </summary>
    public static JsonDocument? TryParse(string text)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text, ParseOptions);
        }
        catch (Exception error) when (error is JsonException or ArgumentException)
        {
            return null;
        }

        try
        {
            CheckStrings(document.RootElement);
            return document;
        }
        catch (InvalidOperationException)
        {
            document.Dispose();
            return null;
        }
    }

    private static void CheckStrings(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                _ = element.GetString();
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    CheckStrings(item);
                }

                break;
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    _ = property.Name;
                    CheckStrings(property.Value);
                }

                break;
            default:
                break;
        }
    }

    /// <summary>An object's properties as JavaScript holds them after <c>JSON.parse</c>.</summary>
    public static IReadOnlyList<KeyValuePair<string, JsonElement>> Properties(JsonElement element)
    {
        var order = new List<string>();
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!values.ContainsKey(property.Name))
            {
                order.Add(property.Name);
            }

            values[property.Name] = property.Value;
        }

        var indexes = order.Where(IsArrayIndex).OrderBy(key => uint.Parse(key, CultureInfo.InvariantCulture));
        return [.. indexes.Concat(order.Where(key => !IsArrayIndex(key))).Select(key => KeyValuePair.Create(key, values[key]))];
    }

    /// <summary>The last property of that name, as <c>record[name]</c> reads it.</summary>
    public static bool TryGet(JsonElement element, string name, out JsonElement value)
    {
        var found = false;
        value = default;
        foreach (var property in element.EnumerateObject())
        {
            if (property.NameEquals(name))
            {
                value = property.Value;
                found = true;
            }
        }

        return found;
    }

    private static bool IsArrayIndex(string key) =>
        key.Length is > 0 and <= 10
        && key.All(char.IsAsciiDigit)
        && (key == "0" || key[0] != '0')
        && ulong.Parse(key, CultureInfo.InvariantCulture) <= 4_294_967_294;

    /// <summary>The number as JavaScript holds it: a double, infinite when it overflows.</summary>
    public static double Number(JsonElement element)
    {
        if (element.TryGetDouble(out var value))
        {
            return value;
        }

        return element.GetRawText().StartsWith('-') ? double.NegativeInfinity : double.PositiveInfinity;
    }

    /// <summary><c>String(value)</c> for a value <c>JSON.parse</c> made.</summary>
    public static string ToJsString(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString()!,
        JsonValueKind.Number => FormatNumber(Number(element)),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => "null",
        JsonValueKind.Array => string.Join(',', element.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.Null ? "" : ToJsString(item))),
        _ => "[object Object]",
    };

    /// <summary>JavaScript's <c>Number.prototype.toString()</c>.</summary>
    public static string FormatNumber(double value)
    {
        if (double.IsNaN(value))
        {
            return "NaN";
        }

        if (double.IsInfinity(value))
        {
            return value > 0 ? "Infinity" : "-Infinity";
        }

        if (value == 0)
        {
            return "0";
        }

        if (value < 0)
        {
            return "-" + FormatNumber(-value);
        }

        // The shortest digits that round trip, as both runtimes pick them, and the exponent n
        // with value = 0.d1d2d3... * 10^n.
        var (digits, n) = ShortestDigits(value);
        var k = digits.Length;
        if (k <= n && n <= 21)
        {
            return digits + new string('0', n - k);
        }

        if (0 < n && n <= 21)
        {
            return digits[..n] + "." + digits[n..];
        }

        if (-6 < n && n <= 0)
        {
            return "0." + new string('0', -n) + digits;
        }

        var exponent = n - 1;
        var sign = exponent < 0 ? "-" : "+";
        var mantissa = k == 1 ? digits : digits[..1] + "." + digits[1..];
        return mantissa + "e" + sign + Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
    }

    private static (string Digits, int Exponent) ShortestDigits(double value)
    {
        var text = value.ToString("R", CultureInfo.InvariantCulture);
        var exponent = 0;
        var e = text.IndexOfAny(['E', 'e']);
        if (e >= 0)
        {
            exponent = int.Parse(text[(e + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            text = text[..e];
        }

        var point = text.IndexOf('.', StringComparison.Ordinal);
        var whole = point < 0 ? text : text[..point];
        var fraction = point < 0 ? "" : text[(point + 1)..];
        var all = whole + fraction;
        var position = whole.Length + exponent;
        var leading = all.Length - all.TrimStart('0').Length;
        var digits = all.Trim('0');
        return (digits, position - leading);
    }

    /// <summary><c>JSON.stringify(value, null, 2)</c>.</summary>
    public static string Stringify(JsonElement element)
    {
        var builder = new StringBuilder();
        Write(builder, element, 0);
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, JsonElement element, int depth)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var properties = Properties(element);
                if (properties.Count == 0)
                {
                    builder.Append("{}");
                    return;
                }

                builder.Append('{');
                for (var index = 0; index < properties.Count; index++)
                {
                    builder.Append(index == 0 ? "\n" : ",\n").Append(' ', (depth + 1) * 2);
                    Quote(builder, properties[index].Key);
                    builder.Append(": ");
                    Write(builder, properties[index].Value, depth + 1);
                }

                builder.Append('\n').Append(' ', depth * 2).Append('}');
                return;
            case JsonValueKind.Array:
                var first = true;
                foreach (var item in element.EnumerateArray())
                {
                    builder.Append(first ? "[\n" : ",\n").Append(' ', (depth + 1) * 2);
                    Write(builder, item, depth + 1);
                    first = false;
                }

                if (first)
                {
                    builder.Append("[]");
                    return;
                }

                builder.Append('\n').Append(' ', depth * 2).Append(']');
                return;
            case JsonValueKind.String:
                Quote(builder, element.GetString()!);
                return;
            case JsonValueKind.Number:
                var number = Number(element);
                builder.Append(double.IsFinite(number) ? FormatNumber(number) : "null");
                return;
            case JsonValueKind.True:
                builder.Append("true");
                return;
            case JsonValueKind.False:
                builder.Append("false");
                return;
            default:
                builder.Append("null");
                return;
        }
    }

    private static void Quote(StringBuilder builder, string text)
    {
        builder.Append('"');
        foreach (var c in text)
        {
            switch (c)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (c < ' ')
                    {
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }

                    break;
            }
        }

        builder.Append('"');
    }
}
