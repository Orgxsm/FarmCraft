#!/bin/bash
set -e

echo "=== PKHeX Local Setup Script ==="
echo ""

# Check .NET SDK
if ! command -v dotnet &> /dev/null; then
    echo "ERROR: .NET 10 SDK is required. Install from https://dotnet.microsoft.com/download/dotnet/10.0"
    exit 1
fi

DOTNET_VERSION=$(dotnet --version)
echo "Found .NET SDK: $DOTNET_VERSION"

# Clone PKHeX if not already present
PKHEX_DIR="$(dirname "$0")/PKHeX"
if [ ! -d "$PKHEX_DIR" ]; then
    echo "Cloning PKHeX..."
    git clone https://github.com/kwsch/PKHeX.git "$PKHEX_DIR"
else
    echo "PKHeX directory already exists, pulling latest..."
    cd "$PKHEX_DIR" && git pull && cd -
fi

cd "$PKHEX_DIR"

# Restore NuGet packages
echo "Restoring NuGet packages..."
dotnet restore PKHeX.sln

# Check file descriptor limit - PKHeX.Drawing.PokeSprite has ~6000 image resources
# which exceeds the default 1024/4096 fd limit on many systems
FDLIMIT=$(ulimit -n)
echo "Current file descriptor limit: $FDLIMIT"

if [ "$FDLIMIT" -lt 8192 ]; then
    echo ""
    echo "WARNING: File descriptor limit ($FDLIMIT) is too low for building PKHeX.Drawing.PokeSprite."
    echo "The project has ~6000 sprite resources that need to be opened simultaneously during build."
    echo ""
    echo "Attempting workaround: pre-compiling resources with custom tool..."

    # Build the resource generator tool
    RESGEN_DIR="$(dirname "$0")/resgen-tool"
    if [ ! -d "$RESGEN_DIR" ]; then
        mkdir -p "$RESGEN_DIR"
        cat > "$RESGEN_DIR/resgen-tool.csproj" << 'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="System.Resources.Extensions" Version="10.0.1" />
  </ItemGroup>
</Project>
CSPROJ
        cat > "$RESGEN_DIR/Program.cs" << 'CSEOF'
using System;
using System.IO;
using System.Resources;
using System.Xml;
using System.Collections.Generic;

var resxPath = args[0];
var outputPath = args[1];
var basePath = Path.GetDirectoryName(Path.GetFullPath(resxPath))!;

Console.WriteLine($"Reading {resxPath}...");
var doc = new XmlDocument();
doc.Load(resxPath);

var entries = new List<Tuple<string, string, string>>();
foreach (XmlNode node in doc.SelectNodes("//data")!)
{
    string eName = node.Attributes!["name"]!.Value;
    string eType = node.Attributes["type"]?.Value ?? "";
    var valueNode = node.SelectSingleNode("value");
    if (valueNode != null)
        entries.Add(Tuple.Create(eName, eType, valueNode.InnerText));
}

Console.WriteLine($"Found {entries.Count} entries, writing to {outputPath}...");
using var writer = new ResourceWriter(outputPath);
int count = 0;
foreach (var entry in entries)
{
    string eName = entry.Item1;
    string eType = entry.Item2;
    string eVal = entry.Item3;

    if (eType.Contains("System.Drawing.Bitmap") || eType.Contains("System.Drawing.Icon"))
    {
        var fullPath = Path.GetFullPath(Path.Combine(basePath, eVal));
        if (File.Exists(fullPath))
        {
            var bytes = File.ReadAllBytes(fullPath);
            writer.AddResource(eName, new MemoryStream(bytes));
            count++;
            if (count % 500 == 0)
                Console.WriteLine($"  Processed {count}/{entries.Count}...");
        }
        else
            Console.WriteLine($"  WARNING: File not found: {fullPath}");
    }
    else
    {
        writer.AddResource(eName, eVal);
        count++;
    }
}
writer.Generate();
Console.WriteLine($"Done! Wrote {count} resources to {outputPath}");
CSEOF
    fi

    echo "Building resource generator..."
    dotnet build "$RESGEN_DIR" -c Release --quiet

    # Pre-compile the large .resources file
    RESOURCES_DIR="PKHeX.Drawing.PokeSprite/obj/Release/net10.0-windows"
    mkdir -p "$RESOURCES_DIR"
    echo "Pre-compiling PokeSprite resources (this may take a moment)..."
    dotnet run --project "$RESGEN_DIR" -c Release -- \
        PKHeX.Drawing.PokeSprite/Properties/Resources.resx \
        "$RESOURCES_DIR/PKHeX.Drawing.PokeSprite.Properties.Resources.resources"

    # Patch the .csproj to use pre-compiled resources
    if ! grep -q "SkipLargeResx" PKHeX.Drawing.PokeSprite/PKHeX.Drawing.PokeSprite.csproj; then
        echo "Patching PKHeX.Drawing.PokeSprite.csproj to use pre-compiled resources..."
        sed -i '/<\/Project>/i \
  <!-- Workaround for low file descriptor limit: use pre-compiled .resources -->\
  <Target Name="SkipLargeResx" AfterTargets="ResolveAssemblyReferences" BeforeTargets="GenerateResource">\
    <ItemGroup>\
      <EmbeddedResource Remove="Properties\\Resources.resx" />\
      <EmbeddedResource Include="obj\\$(Configuration)\\$(TargetFramework)\\PKHeX.Drawing.PokeSprite.Properties.Resources.resources">\
        <LogicalName>PKHeX.Drawing.PokeSprite.Properties.Resources.resources</LogicalName>\
      </EmbeddedResource>\
    </ItemGroup>\
  </Target>' PKHeX.Drawing.PokeSprite/PKHeX.Drawing.PokeSprite.csproj
    fi
else
    echo "File descriptor limit is sufficient ($FDLIMIT), no workaround needed."
fi

# Build
echo ""
echo "Building PKHeX..."
dotnet build PKHeX.sln -c Release

echo ""
echo "=== Build complete! ==="
echo ""
echo "Output: $PKHEX_DIR/PKHeX.WinForms/bin/Release/net10.0-windows/win-x64/PKHeX.dll"
echo ""
echo "NOTE: PKHeX.WinForms is a Windows Forms application."
echo "  - On Windows: dotnet run --project PKHeX.WinForms -c Release"
echo "  - On Linux/macOS: The WinForms GUI requires Windows. You can use the PKHeX.Core library programmatically."
echo ""
echo "To run unit tests:"
echo "  cd $PKHEX_DIR && dotnet test Tests/PKHeX.Core.Tests -c Release"
