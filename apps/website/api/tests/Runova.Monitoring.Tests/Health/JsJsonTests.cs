using System.Text.Json;
using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>JavaScript's number printing, which the parser uses for String(value) and JSON.stringify.</summary>
public sealed class JsJsonTests
{
    [Theory]
    [InlineData(0.0, "0")]
    [InlineData(1.0, "1")]
    [InlineData(-42.0, "-42")]
    [InlineData(1.5, "1.5")]
    [InlineData(0.1, "0.1")]
    [InlineData(123.456, "123.456")]
    [InlineData(100.0, "100")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1.5e300, "1.5e+300")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(0.0000001, "1e-7")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(123e-20, "1.23e-18")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(0.30000000000000004, "0.30000000000000004")]
    [InlineData(9007199254740993.0, "9007199254740992")]
    [InlineData(1234567890123456789.0, "1234567890123456800")]
    [InlineData(double.PositiveInfinity, "Infinity")]
    [InlineData(double.NegativeInfinity, "-Infinity")]
    [InlineData(double.NaN, "NaN")]
    public void Prints_numbers_like_JavaScript(double value, string expected)
    {
        Assert.Equal(expected, JsJson.FormatNumber(value));
    }

    [Fact]
    public void Prints_negative_zero_as_zero()
    {
        Assert.Equal("0", JsJson.FormatNumber(-0.0));
    }

    [Fact]
    public void Reads_a_number_too_large_for_a_double_as_infinity()
    {
        using var document = JsonDocument.Parse("[1e400, -1e400]");
        var items = document.RootElement.EnumerateArray().ToArray();
        Assert.Equal(double.PositiveInfinity, JsJson.Number(items[0]));
        Assert.Equal(double.NegativeInfinity, JsJson.Number(items[1]));
        Assert.Equal("[\n  null,\n  null\n]", JsJson.Stringify(document.RootElement));
    }

    [Fact]
    public void Escapes_strings_like_JSON_stringify()
    {
        using var document = JsonDocument.Parse("""["a\"b\\c\b\f\n\r\t\u0001</script>&'"]""");
        Assert.Equal("[\n  \"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001</script>&'\"\n]", JsJson.Stringify(document.RootElement));
    }
}
