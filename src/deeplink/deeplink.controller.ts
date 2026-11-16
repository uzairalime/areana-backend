import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { BookingsService } from '../bookings/bookings.service';
import { VenuesService } from '../venues/venues.service';

/**
 * Shareable deep links: areana.pk/v/:id and areana.pk/join/:code.
 * Serve a small landing page with app-link intent + web fallback.
 */
@ApiTags('deeplinks')
@Public()
@Controller()
export class DeeplinkController {
  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
    private venues: VenuesService,
  ) {}

  @Get('v/:id')
  @Header('content-type', 'text/html')
  async venueLink(@Param('id') id: string): Promise<string> {
    let title = 'Areana';
    try {
      const v = await this.venues.getById(id);
      title = `${v.name} — Areana`;
    } catch {
      /* fall through with generic title */
    }
    return this.page(title, `areana://v/${encodeURIComponent(id)}`, `Open the Areana app to view this arena.`);
  }

  @Get('join/:code')
  @Header('content-type', 'text/html')
  async joinLink(@Param('code') code: string): Promise<string> {
    let title = 'Join the game — Areana';
    let desc = 'Open the Areana app to join this booking.';
    try {
      const b = await this.bookings.getShared(code);
      title = `Join the game at ${b.venue.name} — Areana`;
      desc = `${b.court.sport} on ${String(b.date).slice(0, 10)} — tap to join.`;
    } catch {
      /* fall through */
    }
    return this.page(title, `areana://join/${encodeURIComponent(code)}`, desc);
  }

  /**
   * HTML-escape for text AND double-quoted attribute contexts. Venue
   * names, sports, and dates are user-controlled strings interpolated
   * into this page — without escaping, a crafted venue name breaks out
   * of <title>/<h1> (stored XSS on a trusted page). The deep link
   * itself is built from encodeURIComponent'd path params (so quotes,
   * backslashes, and </script> cannot survive in it) and escaped here
   * as defence in depth before it lands in href="..." and the JS
   * string below.
   */
  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private page(title: string, deepLink: string, desc: string): string {
    const t = this.esc(title);
    const d = this.esc(desc);
    const l = this.esc(deepLink);
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${t}</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;padding:24px">
<div><h1 style="font-size:22px">${t}</h1><p style="color:#94a3b8">${d}</p>
<a href="${l}" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#22c55e;color:#04120a;border-radius:10px;text-decoration:none;font-weight:700">Open in Areana app</a></div>
<script>setTimeout(()=>{window.location.href="${l}"},800);</script>
</body></html>`;
  }
}
