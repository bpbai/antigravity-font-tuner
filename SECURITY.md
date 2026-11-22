# Security Policy / 安全政策

## Supported Versions / 支持版本

Only the latest release on the `main` branch receives security updates.

| Version | Supported |
| ------- | --------- |
| `1.x` (`main`) | Yes |

## Reporting a Vulnerability / 漏洞报告

**Please do not report security vulnerabilities in public GitHub Issues.**  
**请勿在公开 Issue 中直接发布安全漏洞细节。**

Please submit reports privately via GitHub **Private vulnerability reporting**:
1. Open the repository **Security** tab.
2. Click **Advisories** → **Report a vulnerability**.
3. Provide affected files/components (`server.mjs`, `cdp_injector.mjs`, `install.mjs`, etc.), reproduction steps, and potential impact.

## Security Design Notes / 安全设计说明

- **Non-invasive**: Never patches `app.asar` or Antigravity binaries.
- **Loopback-only CDP**: Connects only to `127.0.0.1` CDP targets matching the verified local Language Server Hub origin.
- **Zero third-party dependencies**: Uses only Node.js built-in modules and Antigravity's authenticated `sidecar_sdk`.
