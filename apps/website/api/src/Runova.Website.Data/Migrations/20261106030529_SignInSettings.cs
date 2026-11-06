using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class SignInSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SignInSettings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false),
                    CaptchaEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    TurnstileSiteKey = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    TurnstileSecretSealed = table.Column<string>(type: "text", nullable: true),
                    GoogleEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    GoogleClientId = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    GoogleClientSecretSealed = table.Column<string>(type: "text", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SignInSettings", x => x.Id);
                    table.CheckConstraint("CK_SignInSettings_Singleton", "\"Id\" = 1");
                });

            migrationBuilder.InsertData(
                table: "SignInSettings",
                columns: new[] { "Id", "CaptchaEnabled", "GoogleClientId", "GoogleClientSecretSealed", "GoogleEnabled", "TurnstileSecretSealed", "TurnstileSiteKey", "UpdatedAt" },
                values: new object[] { 1, false, null, null, true, null, null, null });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SignInSettings");
        }
    }
}
