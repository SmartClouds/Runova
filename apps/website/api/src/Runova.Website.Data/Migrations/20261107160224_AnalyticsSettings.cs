using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class AnalyticsSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AnalyticsSettings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false),
                    TagsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    GoogleAnalyticsIds = table.Column<string[]>(type: "text[]", nullable: false),
                    GoogleAdsIds = table.Column<string[]>(type: "text[]", nullable: false),
                    GoogleTagManagerId = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    ClarityProjectId = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    BingUetTagId = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: true),
                    GoogleSiteVerification = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    BingSiteVerification = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ConsentBannerEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AnalyticsSettings", x => x.Id);
                    table.CheckConstraint("CK_AnalyticsSettings_Singleton", "\"Id\" = 1");
                });

            migrationBuilder.InsertData(
                table: "AnalyticsSettings",
                columns: new[] { "Id", "BingSiteVerification", "BingUetTagId", "ClarityProjectId", "ConsentBannerEnabled", "GoogleAdsIds", "GoogleAnalyticsIds", "GoogleSiteVerification", "GoogleTagManagerId", "TagsEnabled", "UpdatedAt" },
                values: new object[] { 1, null, null, null, false, new string[0], new string[0], null, null, false, null });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AnalyticsSettings");
        }
    }
}
