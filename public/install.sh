#!/bin/sh
set -e

REPO="https://github.com/legendum/wikis.git"
INSTALL_DIR="$HOME/.config/wikis/src"

echo "Installing wikis..."

# Check for bun
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull
else
  echo "Cloning repository..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies
bun install

# Link globally
bun link

echo ""
echo "Done! Run 'wikis --help' to get started."
echo ""
echo "Quick start:"
echo "  cd your-project"
echo "  wikis init       # create wiki/ folder"
echo "  wikis start      # start the daemon"
