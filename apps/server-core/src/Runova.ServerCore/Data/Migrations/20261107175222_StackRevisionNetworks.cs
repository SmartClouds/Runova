using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class StackRevisionNetworks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Networks",
                table: "StackRevisions",
                type: "TEXT",
                nullable: false,
                defaultValue: "[]");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Networks",
                table: "StackRevisions");
        }
    }
}
