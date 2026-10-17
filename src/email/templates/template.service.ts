import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import { EMAIL_OPTIONS } from '../email.constants';
import { EmailModuleOptions } from '../interfaces/email.interfaces';

@Injectable()
export class TemplateService {
  private readonly dir: string;
  private readonly cache = new Map<string, HandlebarsTemplateDelegate>();

  constructor(@Inject(EMAIL_OPTIONS) opts: EmailModuleOptions) {
    this.dir = path.resolve(opts.templatesDir ?? path.join(process.cwd(), 'templates', 'email'));
  }

  render(name: string, context: Record<string, unknown> = {}): { html: string; text: string } {
    // Whitelist chars + path containment check => no path traversal
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      throw new NotFoundException('Invalid template name');
    }
    const file = path.resolve(this.dir, `${name}.hbs`);
    if (!file.startsWith(this.dir + path.sep) || !fs.existsSync(file)) {
      throw new NotFoundException(`Template "${name}" not found`);
    }

    let tpl = this.cache.get(file);
    if (!tpl) {
      // Default Handlebars escaping stays ON ({{var}} is HTML-escaped) => XSS-safe
      tpl = Handlebars.compile(fs.readFileSync(file, 'utf8'), { strict: false });
      this.cache.set(file, tpl);
    }
    const html = tpl(context);
    return { html, text: this.htmlToText(html) };
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}