using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations;

/// <inheritdoc />
public partial class TrafficAndAttacks : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "AttackEvents",
            columns: table => new
            {
                Id = table.Column<long>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                Kind = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                Address = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                Country = table.Column<string>(type: "TEXT", maxLength: 2, nullable: true),
                FirstSeenAt = table.Column<long>(type: "INTEGER", nullable: false),
                LastSeenAt = table.Column<long>(type: "INTEGER", nullable: false),
                Count = table.Column<int>(type: "INTEGER", nullable: false),
                SamplePaths = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: false),
                Blocked = table.Column<bool>(type: "INTEGER", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_AttackEvents", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "BlockedAddresses",
            columns: table => new
            {
                Id = table.Column<long>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                Network = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                Reason = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                Automatic = table.Column<bool>(type: "INTEGER", nullable: false),
                CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: true),
                ExpiresAt = table.Column<long>(type: "INTEGER", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_BlockedAddresses", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "TrafficDays",
            columns: table => new
            {
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                Day = table.Column<int>(type: "INTEGER", nullable: false),
                StartUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                Requests = table.Column<long>(type: "INTEGER", nullable: false),
                PageViews = table.Column<long>(type: "INTEGER", nullable: false),
                Visits = table.Column<long>(type: "INTEGER", nullable: false),
                Bounces = table.Column<long>(type: "INTEGER", nullable: false),
                VisitSeconds = table.Column<long>(type: "INTEGER", nullable: false),
                Bytes = table.Column<long>(type: "INTEGER", nullable: false),
                BotRequests = table.Column<long>(type: "INTEGER", nullable: false),
                Status2xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status3xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status4xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status5xx = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseMsTotal = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseCount = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseHistogram = table.Column<byte[]>(type: "BLOB", nullable: false),
                CountryCloudflare = table.Column<long>(type: "INTEGER", nullable: false),
                CountryDbIp = table.Column<long>(type: "INTEGER", nullable: false),
                CountryUnknown = table.Column<long>(type: "INTEGER", nullable: false),
                Sketch = table.Column<byte[]>(type: "BLOB", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TrafficDays", x => new { x.SiteId, x.Day });
            });

        migrationBuilder.CreateTable(
            name: "TrafficDimensionDays",
            columns: table => new
            {
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                Day = table.Column<int>(type: "INTEGER", nullable: false),
                Dimension = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                Value = table.Column<string>(type: "TEXT", maxLength: 300, nullable: false),
                StartUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                Count = table.Column<long>(type: "INTEGER", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TrafficDimensionDays", x => new { x.SiteId, x.Day, x.Dimension, x.Value });
            });

        migrationBuilder.CreateTable(
            name: "TrafficHours",
            columns: table => new
            {
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                HourUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                Requests = table.Column<long>(type: "INTEGER", nullable: false),
                PageViews = table.Column<long>(type: "INTEGER", nullable: false),
                Visits = table.Column<long>(type: "INTEGER", nullable: false),
                Bounces = table.Column<long>(type: "INTEGER", nullable: false),
                VisitSeconds = table.Column<long>(type: "INTEGER", nullable: false),
                Visitors = table.Column<long>(type: "INTEGER", nullable: false),
                Bytes = table.Column<long>(type: "INTEGER", nullable: false),
                BotRequests = table.Column<long>(type: "INTEGER", nullable: false),
                Status2xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status3xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status4xx = table.Column<long>(type: "INTEGER", nullable: false),
                Status5xx = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseMsTotal = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseCount = table.Column<long>(type: "INTEGER", nullable: false),
                ResponseHistogram = table.Column<byte[]>(type: "BLOB", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TrafficHours", x => new { x.SiteId, x.HourUnixMs });
            });

        migrationBuilder.CreateTable(
            name: "TrafficLogCursors",
            columns: table => new
            {
                SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                Offset = table.Column<long>(type: "INTEGER", nullable: false),
                Fingerprint = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                FingerprintLength = table.Column<int>(type: "INTEGER", nullable: false),
                LastLineAt = table.Column<long>(type: "INTEGER", nullable: true),
                UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TrafficLogCursors", x => x.SiteId);
            });

        migrationBuilder.CreateTable(
            name: "TrafficSettings",
            columns: table => new
            {
                Id = table.Column<int>(type: "INTEGER", nullable: false),
                Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                Countries = table.Column<bool>(type: "INTEGER", nullable: false),
                ExcludedSites = table.Column<string>(type: "TEXT", maxLength: 40000, nullable: false),
                HourlyRetentionDays = table.Column<int>(type: "INTEGER", nullable: false),
                DailyRetentionDays = table.Column<int>(type: "INTEGER", nullable: false),
                TimeZone = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                EnabledAt = table.Column<long>(type: "INTEGER", nullable: true),
                AttackEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                DetectionChosen = table.Column<bool>(type: "INTEGER", nullable: false),
                ScanProbes = table.Column<int>(type: "INTEGER", nullable: false),
                ScanNotFound = table.Column<int>(type: "INTEGER", nullable: false),
                ScanWindowMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                BruteForceAttempts = table.Column<int>(type: "INTEGER", nullable: false),
                BruteForceWindowMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                FloodRequestsPerMinute = table.Column<int>(type: "INTEGER", nullable: false),
                InjectionHits = table.Column<int>(type: "INTEGER", nullable: false),
                InjectionWindowMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                Allowlist = table.Column<string>(type: "TEXT", maxLength: 40000, nullable: false),
                EventRetentionDays = table.Column<int>(type: "INTEGER", nullable: false),
                AutoBlockEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                AutoBlockKinds = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                AutoBlockMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                AutoBlockMaxBlocked = table.Column<int>(type: "INTEGER", nullable: false),
                ChangedAt = table.Column<long>(type: "INTEGER", nullable: true),
                ChangedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TrafficSettings", x => x.Id);
            });

        migrationBuilder.CreateIndex(
            name: "IX_AttackEvents_LastSeenAt",
            table: "AttackEvents",
            column: "LastSeenAt");

        migrationBuilder.CreateIndex(
            name: "IX_AttackEvents_SiteId_LastSeenAt",
            table: "AttackEvents",
            columns: new[] { "SiteId", "LastSeenAt" });

        migrationBuilder.CreateIndex(
            name: "IX_BlockedAddresses_ExpiresAt",
            table: "BlockedAddresses",
            column: "ExpiresAt");

        migrationBuilder.CreateIndex(
            name: "IX_BlockedAddresses_Network",
            table: "BlockedAddresses",
            column: "Network",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_TrafficDays_SiteId_StartUnixMs",
            table: "TrafficDays",
            columns: new[] { "SiteId", "StartUnixMs" });

        migrationBuilder.CreateIndex(
            name: "IX_TrafficDays_StartUnixMs",
            table: "TrafficDays",
            column: "StartUnixMs");

        migrationBuilder.CreateIndex(
            name: "IX_TrafficDimensionDays_SiteId_Dimension_StartUnixMs",
            table: "TrafficDimensionDays",
            columns: new[] { "SiteId", "Dimension", "StartUnixMs" });

        migrationBuilder.CreateIndex(
            name: "IX_TrafficDimensionDays_StartUnixMs",
            table: "TrafficDimensionDays",
            column: "StartUnixMs");

        migrationBuilder.CreateIndex(
            name: "IX_TrafficHours_HourUnixMs",
            table: "TrafficHours",
            column: "HourUnixMs");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "AttackEvents");

        migrationBuilder.DropTable(
            name: "BlockedAddresses");

        migrationBuilder.DropTable(
            name: "TrafficDays");

        migrationBuilder.DropTable(
            name: "TrafficDimensionDays");

        migrationBuilder.DropTable(
            name: "TrafficHours");

        migrationBuilder.DropTable(
            name: "TrafficLogCursors");

        migrationBuilder.DropTable(
            name: "TrafficSettings");
    }
}
