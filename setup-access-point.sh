#!/usr/bin/env bash
# Muss mit sudo laufen: sudo bash setup-access-point.sh [install|activate|all]
#
# Nutzt hostapd direkt (nicht NetworkManager) – zuverlässiger auf RPi BCM-Chip
#
#   install   – alles vorbereiten, Verbindung bleibt aktiv
#   activate  – WLAN-Interface auf AP umstellen (Verbindung via Ethernet bleibt!)
#   all       – beides

set -euo pipefail

SSID="Festo-EduKit"
PASSWORD="festo1234"
IFACE="wlan0"
AP_IP="10.42.0.1"
PROJECT_DIR="/home/creampi/Documents/Projects/Fuellstandsregelung_Festo_Edukit/festo-dpa-level-control"

do_install() {
  echo "=== 1. Pakete installieren ==="
  apt-get install -y hostapd dnsmasq iptables-persistent

  echo "=== 2. NM-AP-Profil aufräumen ==="
  nmcli con delete "Festo-AP" 2>/dev/null || true

  echo "=== 3. NM anweisen wlan0 zu ignorieren ==="
  mkdir -p /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/99-unmanaged-wlan0.conf <<EOF
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF

  echo "=== 4. hostapd konfigurieren ==="
  cat > /etc/hostapd/festo-hostapd.conf <<EOF
interface=$IFACE
driver=nl80211
ssid=$SSID
hw_mode=g
channel=6
ieee80211n=1
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=$PASSWORD
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
country_code=DE
EOF

  echo "=== 5. dnsmasq konfigurieren (DHCP + Captive Portal DNS) ==="
  # Systemweiten dnsmasq deaktivieren, wir nutzen unsere eigene Instanz im Service
  systemctl disable dnsmasq 2>/dev/null || true
  systemctl stop dnsmasq 2>/dev/null || true

  cat > /etc/dnsmasq.d/festo-ap.conf <<EOF
# Nur auf wlan0 lauschen
interface=$IFACE
bind-interfaces

# DHCP: Clients bekommen 10.42.0.10 - 10.42.0.50
dhcp-range=10.42.0.10,10.42.0.50,255.255.255.0,24h

# Captive Portal: alle DNS-Anfragen auf den Pi
address=/#/$AP_IP
EOF

  echo "=== 6. Systemd-Service für AP erstellen ==="
  cat > /etc/systemd/system/festo-ap.service <<EOF
[Unit]
Description=Festo EduKit Access Point (hostapd + dnsmasq)
After=network.target
Before=edukit-dashboard.service

[Service]
Type=oneshot
RemainAfterExit=yes

# Interface aufsetzen
ExecStart=/sbin/ip link set $IFACE up
ExecStart=/sbin/ip addr replace $AP_IP/24 dev $IFACE

# hostapd starten
ExecStart=/usr/sbin/hostapd -B /etc/hostapd/festo-hostapd.conf

# dnsmasq starten (nur auf wlan0)
ExecStart=/usr/sbin/dnsmasq --conf-file=/etc/dnsmasq.d/festo-ap.conf

# Port 80 -> 3000 umleiten (Captive Portal)
ExecStart=/sbin/iptables -t nat -A PREROUTING -i $IFACE -p tcp --dport 80 -j REDIRECT --to-port 3000

ExecStop=/sbin/iptables -t nat -D PREROUTING -i $IFACE -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null || true
ExecStop=/usr/bin/pkill -f "dnsmasq.*festo" || true
ExecStop=/usr/bin/pkill hostapd || true
ExecStop=/sbin/ip addr flush dev $IFACE

[Install]
WantedBy=multi-user.target
EOF

  echo "=== 7. Dashboard-Service installieren ==="
  chmod +x "$PROJECT_DIR/edukit-service.sh"
  cp "$PROJECT_DIR/edukit-dashboard.service" /etc/systemd/system/

  systemctl daemon-reload
  systemctl enable festo-ap.service
  systemctl enable edukit-dashboard.service

  echo ""
  echo "======================================"
  echo "  Installation fertig."
  echo "  Zum Aktivieren: sudo bash setup-access-point.sh activate"
  echo "======================================"
}

do_activate() {
  echo "=== NM neu starten (ignoriert jetzt wlan0) ==="
  systemctl restart NetworkManager
  sleep 2

  echo "=== AP starten ==="
  systemctl start festo-ap.service

  sleep 2
  echo ""
  if iw dev wlan0 info 2>/dev/null | grep -q "type AP"; then
    echo "✓ AP läuft!"
    echo "  SSID:      $SSID"
    echo "  Passwort:  $PASSWORD"
    echo "  IP:        http://$AP_IP:3000"
  else
    echo "✗ AP-Status unklar – bitte prüfen:"
    echo "  systemctl status festo-ap"
    echo "  journalctl -u festo-ap -n 30"
  fi

  echo "=== Dashboard starten ==="
  systemctl start edukit-dashboard.service
}

CMD="${1:-}"
case "$CMD" in
  install)   do_install ;;
  activate)  do_activate ;;
  all)       do_install; do_activate ;;
  *)
    echo "Verwendung: sudo bash setup-access-point.sh [install|activate|all]"
    exit 1 ;;
esac
