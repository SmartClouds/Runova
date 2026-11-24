using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations;

/// <inheritdoc />
public partial class StackAdminAcknowledgments : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "AdminAcknowledgedRisks",
            table: "StackRevisions",
            type: "TEXT",
            nullable: false,
            defaultValue: "[]");

        // Acknowledgments made before only Admins could acknowledge a critical finding keep
        // counting, so an app that runs now still starts and restarts.
        migrationBuilder.Sql("UPDATE StackRevisions SET AdminAcknowledgedRisks = AcknowledgedRisks;");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "AdminAcknowledgedRisks",
            table: "StackRevisions");
    }
}
