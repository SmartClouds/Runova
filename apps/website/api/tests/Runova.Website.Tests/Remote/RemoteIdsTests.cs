using Runova.Website.Api.Remote;

namespace Runova.Website.Tests.Remote;

public class RemoteIdsTests
{
    [Fact]
    public void A_new_id_is_nine_digits_and_never_starts_with_zero()
    {
        for (var i = 0; i < 2_000; i++)
        {
            var id = RemoteIds.New();

            Assert.Matches("^[1-9][0-9]{8}$", id);
        }
    }

    [Fact]
    public void New_ids_are_spread_out()
    {
        var ids = Enumerable.Range(0, 500).Select(_ => RemoteIds.New()).ToHashSet();

        Assert.True(ids.Count > 495);
    }

    [Theory]
    [InlineData("482193775", "482193775")]
    [InlineData("482 193 775", "482193775")]
    [InlineData(" 482-193-775 ", "482193775")]
    [InlineData("482 193 775", "482193775")]
    public void Typed_ids_lose_their_spaces_and_dashes(string typed, string expected)
    {
        Assert.Equal(expected, RemoteIds.Parse(typed));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("12345678")]
    [InlineData("1234567890")]
    [InlineData("012345678")]
    [InlineData("48219377a")]
    [InlineData("４８２１９３７７５")]
    public void Anything_else_is_not_an_id(string? typed)
    {
        Assert.Null(RemoteIds.Parse(typed));
    }

    [Fact]
    public void An_id_is_shown_in_groups_of_three()
    {
        Assert.Equal("482 193 775", RemoteIds.Format("482193775"));
    }
}
