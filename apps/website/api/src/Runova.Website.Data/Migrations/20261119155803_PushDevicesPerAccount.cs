using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.Website.Data.Migrations;

/// <inheritdoc />
public partial class PushDevicesPerAccount : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_PushDevices_PushToken",
            table: "PushDevices");

        migrationBuilder.DropIndex(
            name: "IX_PushDevices_UserId",
            table: "PushDevices");

        migrationBuilder.AddColumn<string>(
            name: "AccountTag",
            table: "PushDevices",
            type: "character varying(32)",
            maxLength: 32,
            nullable: true);

        migrationBuilder.CreateIndex(
            name: "IX_PushDevices_PushToken",
            table: "PushDevices",
            column: "PushToken");

        migrationBuilder.CreateIndex(
            name: "IX_PushDevices_UserId_PushToken",
            table: "PushDevices",
            columns: new[] { "UserId", "PushToken" },
            unique: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_PushDevices_PushToken",
            table: "PushDevices");

        migrationBuilder.DropIndex(
            name: "IX_PushDevices_UserId_PushToken",
            table: "PushDevices");

        migrationBuilder.DropColumn(
            name: "AccountTag",
            table: "PushDevices");

        migrationBuilder.CreateIndex(
            name: "IX_PushDevices_PushToken",
            table: "PushDevices",
            column: "PushToken",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_PushDevices_UserId",
            table: "PushDevices",
            column: "UserId");
    }
}
