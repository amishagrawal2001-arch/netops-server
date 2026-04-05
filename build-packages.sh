#!/usr/bin/env bash
# Build Linux installer packages for NetOps Server
set -e

VERSION="1.0.0"
NAME="netops-server"
BUILD_DIR="$(pwd)/build"
PKG_DIR="$(pwd)/packaging"

echo "🔧 Building NetOps Server v${VERSION} packages..."

# Clean
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Compile TypeScript (need devDeps for tsc, then prune)
echo "📦 Compiling TypeScript..."
npm install 2>/dev/null
npx tsc
npm prune --production 2>/dev/null

# ── Build .tar.gz (generic Linux) ──────────────────────────────
echo "📦 Building tarball..."
TAR_DIR="$BUILD_DIR/${NAME}-${VERSION}"
mkdir -p "$TAR_DIR"
cp -r package.json tsconfig.json src/ dist/ install.sh README.md Dockerfile docker-compose.yml "$TAR_DIR/"
cd "$BUILD_DIR"
tar czf "${NAME}-${VERSION}-linux.tar.gz" "${NAME}-${VERSION}/"
cd ..
echo "   ✓ build/${NAME}-${VERSION}-linux.tar.gz"

# ── Build .deb (Debian/Ubuntu) ─────────────────────────────────
echo "📦 Building .deb package..."
DEB_DIR="$BUILD_DIR/deb-staging"
mkdir -p "$DEB_DIR/opt/netops-server"
mkdir -p "$DEB_DIR/etc/systemd/system"
mkdir -p "$DEB_DIR/DEBIAN"

# Copy app files
cp -r package.json tsconfig.json src/ dist/ "$DEB_DIR/opt/netops-server/"

# Copy packaging files
cp "$PKG_DIR/deb/DEBIAN/control" "$DEB_DIR/DEBIAN/"
cp "$PKG_DIR/deb/DEBIAN/postinst" "$DEB_DIR/DEBIAN/"
cp "$PKG_DIR/deb/DEBIAN/prerm" "$DEB_DIR/DEBIAN/"
cp "$PKG_DIR/deb/etc/systemd/system/netops-server.service" "$DEB_DIR/etc/systemd/system/"

# Build .deb
if command -v dpkg-deb &> /dev/null; then
    dpkg-deb --build "$DEB_DIR" "$BUILD_DIR/${NAME}_${VERSION}_all.deb"
    echo "   ✓ build/${NAME}_${VERSION}_all.deb"
else
    echo "   ⚠ dpkg-deb not found — skipping .deb (run on Debian/Ubuntu)"
fi

# ── Build .rpm (RHEL/CentOS/Fedora) ───────────────────────────
echo "📦 Building .rpm spec..."
RPM_SPEC="$BUILD_DIR/${NAME}.spec"
cat > "$RPM_SPEC" << SPEC
Name:           ${NAME}
Version:        ${VERSION}
Release:        1
Summary:        NetOps Backend Server for network device polling
License:        Proprietary
URL:            https://github.com/amishagrawal2001-arch/tlink-netops
BuildArch:      noarch
Requires:       nodejs >= 18

%description
Optional standalone backend server for large-scale NetOps
network device polling via SSH/SNMP with REST API and WebSocket.

%install
mkdir -p %{buildroot}/opt/netops-server
cp -r %{_sourcedir}/package.json %{buildroot}/opt/netops-server/
cp -r %{_sourcedir}/tsconfig.json %{buildroot}/opt/netops-server/
cp -r %{_sourcedir}/src %{buildroot}/opt/netops-server/
cp -r %{_sourcedir}/dist %{buildroot}/opt/netops-server/
mkdir -p %{buildroot}/etc/systemd/system
cp %{_sourcedir}/packaging/deb/etc/systemd/system/netops-server.service %{buildroot}/etc/systemd/system/

%post
cd /opt/netops-server && npm install --production 2>/dev/null || true
systemctl daemon-reload
systemctl enable netops-server
systemctl start netops-server

%preun
systemctl stop netops-server 2>/dev/null || true
systemctl disable netops-server 2>/dev/null || true

%files
/opt/netops-server/
/etc/systemd/system/netops-server.service
SPEC

if command -v rpmbuild &> /dev/null; then
    rpmbuild -bb "$RPM_SPEC" 2>/dev/null
    echo "   ✓ RPM built"
else
    echo "   ⚠ rpmbuild not found — .spec file at build/${NAME}.spec (run on RHEL/Fedora)"
fi

echo ""
echo "=================================="
echo "  ✅ Packages built successfully!"
echo "=================================="
echo ""
ls -lh "$BUILD_DIR"/*.tar.gz "$BUILD_DIR"/*.deb 2>/dev/null || true
echo ""
echo "Install:"
echo "  Debian/Ubuntu:  sudo dpkg -i build/${NAME}_${VERSION}_all.deb"
echo "  RHEL/Fedora:    sudo rpm -i build/${NAME}-${VERSION}-1.noarch.rpm"
echo "  Generic Linux:  tar xzf build/${NAME}-${VERSION}-linux.tar.gz && cd ${NAME}-${VERSION} && ./install.sh"
echo "  Docker:         docker compose up -d"
