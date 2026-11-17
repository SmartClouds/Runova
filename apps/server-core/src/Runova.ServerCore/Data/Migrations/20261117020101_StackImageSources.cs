using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations;

/// <inheritdoc />
public partial class StackImageSources : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "ImageSource",
            table: "StackRevisions",
            type: "TEXT",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "ReleaseImage",
            table: "StackRevisions",
            type: "TEXT",
            nullable: true);

        migrationBuilder.CreateTable(
            name: "ReleaseTokens",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                Repository = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                SealedToken = table.Column<string>(type: "TEXT", nullable: false),
                CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                LastUsedAt = table.Column<long>(type: "INTEGER", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_ReleaseTokens", x => x.Id);
            });

        migrationBuilder.CreateIndex(
            name: "IX_ReleaseTokens_Repository",
            table: "ReleaseTokens",
            column: "Repository",
            unique: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "ReleaseTokens");

        migrationBuilder.DropColumn(
            name: "ImageSource",
            table: "StackRevisions");

        migrationBuilder.DropColumn(
            name: "ReleaseImage",
            table: "StackRevisions");
    }
}
