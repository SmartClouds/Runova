using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T4: a visit is one visitor's page views on one site with no gap over 30 minutes. Open
/// visits sit in a bounded map (oldest out first); a closed visit gives its pages and length,
/// which make the bounce rate, pages per visit and visit length.
/// </summary>
public sealed class VisitTrackerTests
{
    private const long Start = 1_800_000_000_000;

    private static long Minutes(double minutes) => Start + (long)(minutes * 60_000);

    [Fact]
    public void Page_views_close_together_are_one_visit_that_closes_after_thirty_quiet_minutes()
    {
        var tracker = new VisitTracker();
        var closed = new List<ClosedVisit>();

        Assert.True(tracker.PageView("app", 1, Minutes(0)));
        Assert.False(tracker.PageView("app", 1, Minutes(10)));
        Assert.False(tracker.PageView("app", 1, Minutes(25)));
        tracker.Close(Minutes(54), closed);
        Assert.Empty(closed);
        tracker.Close(Minutes(55), closed);

        var visit = Assert.Single(closed);
        Assert.Equal(new ClosedVisit("app", 1, Minutes(0), 3, 25 * 60), visit);
        Assert.Equal(0, tracker.Open);
    }

    [Fact]
    public void A_gap_over_thirty_minutes_starts_a_new_visit_and_ends_the_old_one()
    {
        var tracker = new VisitTracker();
        var closed = new List<ClosedVisit>();

        tracker.PageView("app", 1, Minutes(0));
        Assert.True(tracker.PageView("app", 1, Minutes(31), closed));

        var bounce = Assert.Single(closed);
        Assert.Equal((1, 0L), (bounce.Pages, bounce.Seconds));
        Assert.Equal(1, tracker.Open);
    }

    [Fact]
    public void The_same_visitor_on_two_sites_makes_two_visits()
    {
        var tracker = new VisitTracker();

        Assert.True(tracker.PageView("app", 1, Minutes(0)));
        Assert.True(tracker.PageView("blog", 1, Minutes(1)));
        Assert.Equal(2, tracker.Open);
    }

    [Fact]
    public void When_full_the_visit_quiet_longest_ends_first()
    {
        var tracker = new VisitTracker(capacity: 3);
        var closed = new List<ClosedVisit>();
        tracker.PageView("app", 1, Minutes(0));
        tracker.PageView("app", 2, Minutes(1));
        tracker.PageView("app", 3, Minutes(2));
        tracker.PageView("app", 1, Minutes(3));

        tracker.PageView("app", 4, Minutes(4), closed);

        Assert.Equal(2UL, Assert.Single(closed).Visitor);
        Assert.Equal(3, tracker.Open);
        Assert.Equal(100_000, VisitTracker.DefaultCapacity);
    }

    [Fact]
    public void A_page_view_older_than_the_open_visit_still_belongs_to_it()
    {
        var tracker = new VisitTracker();
        var closed = new List<ClosedVisit>();
        tracker.PageView("app", 1, Minutes(10));

        Assert.False(tracker.PageView("app", 1, Minutes(9)));
        tracker.Close(Minutes(100), closed);

        Assert.Equal((2, 60L), (closed[0].Pages, closed[0].Seconds));
        Assert.Equal(Minutes(9), closed[0].StartUnixMs);
    }
}
