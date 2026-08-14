# luci-app-dnsproxy

> [dnsproxy][] is a simple DNS proxy server that supports all existing DNS protocols including
`DNS-over-TLS`, `DNS-over-HTTPS`, `DNSCrypt`, and `DNS-over-QUIC`. Moreover,
it can work as a `DNS-over-HTTPS`, `DNS-over-TLS` or `DNS-over-QUIC` server.

The LuCI interface also supports reusable DNS profiles.  Each profile stores
its own bootstrap, upstream, fallback, and upstream-selection settings.  The
interface identifies the active profile, previews changes before loading or
updating a profile, creates profiles from the current settings, validates their
contents, and supports versioned JSON import and export.  Its built-in tester
can measure A, AAAA, or both record types over 1, 3, 5, or 10 attempts, reports
minimum, average, and maximum response times, tests Bootstrap, Upstream, and
Fallback endpoints independently, and verifies actual fallback activation.
Results are sorted and color-coded, and all saved profiles can be compared with
identical test settings.  The last test domain is stored only in the browser.
Profile editing is kept in a collapsed manager on the **Upstreams** tab.
Editable examples for Cloudflare, Quad9, Google, and a mixed parallel setup
demonstrate the feature.

## How to install

1. Go to [here](https://fantastic-packages.github.io/releases/)
2. Download the latest version of ipk
3. Login router and goto **System --> Software**
4. Upload and install ipk
5. Reboot if the app is not automatically added in page
6. Goto **Services --> DNS Proxy**

## Build

Compile from OpenWrt/LEDE SDK

```
# Take the x86_64 platform as an example
tar xjf openwrt-sdk-22.03.5-x86-64_gcc-8.4.0_musl.Linux-x86_64.tar.xz
# Go to the SDK root dir
cd OpenWrt-sdk-*-x86_64_*
# First run to generate a .config file
make menuconfig
./scripts/feeds update -a
./scripts/feeds install -a
# Get Makefile
git clone --depth 1 --branch master --single-branch --no-checkout https://github.com/muink/luci-app-dnsproxy.git package/luci-app-dnsproxy
pushd package/luci-app-dnsproxy
umask 022
git checkout
popd
# Select the package LuCI -> Applications -> luci-app-dnsproxy
make menuconfig
# Start compiling
make package/luci-app-dnsproxy/compile V=99
```

[dnsproxy]: https://github.com/AdguardTeam/dnsproxy

## License

This project is licensed under the [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
