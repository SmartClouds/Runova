using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class EncryptedItems : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Sealed",
                table: "UserNotifications",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SealKeyId",
                table: "PushDevices",
                type: "character varying(12)",
                maxLength: 12,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "EncryptedItems",
                table: "AccountTypes",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "UserEncryptionPreferences",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    Item = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserEncryptionPreferences", x => new { x.UserId, x.Item });
                    table.ForeignKey(
                        name: "FK_UserEncryptionPreferences_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.UpdateData(
                table: "AccountTypes",
                keyColumn: "Id",
                keyValue: 1L,
                column: "EncryptedItems",
                value: false);

            migrationBuilder.UpdateData(
                table: "AccountTypes",
                keyColumn: "Id",
                keyValue: 2L,
                column: "EncryptedItems",
                value: true);

            migrationBuilder.UpdateData(
                table: "AccountTypes",
                keyColumn: "Id",
                keyValue: 3L,
                column: "EncryptedItems",
                value: true);

            migrationBuilder.UpdateData(
                table: "AccountTypes",
                keyColumn: "Id",
                keyValue: 4L,
                column: "EncryptedItems",
                value: true);

            // Anyone already sealing a personal scope made this choice before the switch existed.
            migrationBuilder.Sql(
                """
                INSERT INTO "UserEncryptionPreferences" ("UserId", "Item", "Enabled", "UpdatedAt")
                SELECT "UserId", 'sync', TRUE, now() FROM "SyncScopes"
                WHERE "Kind" = 'personal' AND "EncryptEverything" AND "UserId" IS NOT NULL
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserEncryptionPreferences");

            migrationBuilder.DropColumn(
                name: "Sealed",
                table: "UserNotifications");

            migrationBuilder.DropColumn(
                name: "SealKeyId",
                table: "PushDevices");

            migrationBuilder.DropColumn(
                name: "EncryptedItems",
                table: "AccountTypes");
        }
    }
}
