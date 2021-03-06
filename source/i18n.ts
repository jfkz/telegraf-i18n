import * as fs from 'fs'
import * as path from 'path'

import {Context as TelegrafContext} from 'telegraf'
import {ExtraReplyMessage, Message} from 'telegraf/typings/telegram-types'
import {MiddlewareFn} from 'telegraf/typings/composer'
import * as yaml from 'js-yaml'

import {Config, LanguageCode, Repository, RepositoryEntry, TemplateData} from './types'
import {I18nContext} from './context'
import {pluralize} from './pluralize'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compile = require('compile-template')

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tableize = require('tableize-object')

interface TelegrafContextWithI18n extends TelegrafContext {
  i18n: I18nContext;
}

interface Session {
  __language_code?: string;
}

export class I18n {
  repository: Repository = {}
  readonly config: Config

  constructor(config: Partial<Config> = {}) {
    this.config = {
      defaultLanguage: 'en',
      sessionName: 'session',
      allowMissing: true,
      templateData: {
        pluralize
      },
      ...config
    }
    if (this.config.directory) {
      this.loadLocales(this.config.directory)
    }
  }

  loadLocales(directory: string) {
    if (!fs.existsSync(directory)) {
      throw new Error(`Locales directory '${directory}' not found`)
    }

    const files = fs.readdirSync(directory)
    for (const fileName of files) {
      const extension = path.extname(fileName)
      const languageCode = path.basename(fileName, extension).toLowerCase()
      const fileContent = fs.readFileSync(path.resolve(directory, fileName), 'utf8')
      let data
      if (extension === '.yaml' || extension === '.yml') {
        data = yaml.safeLoad(fileContent)
      } else if (extension === '.json') {
        data = JSON.parse(fileContent)
      }

      this.loadLocale(languageCode, tableize(data))
    }
  }

  loadLocale(languageCode: LanguageCode, i18nData: Readonly<Record<string, unknown>>): void {
    const language = languageCode.toLowerCase()

    // Get object keys with dot dotation: {a: {b: value}} -> {'a.b': value}
    const tableized: Record<string, string | number | unknown> = tableize(i18nData)

    const ensureStringData: Record<string, string> = {}
    for (const [key, value] of Object.entries(tableized)) {
      ensureStringData[key] = String(value)
    }

    this.repository[language] = {
      ...this.repository[language],
      ...compileTemplates(tableize(ensureStringData))
    }
  }

  resetLocale(languageCode?: LanguageCode): void {
    if (languageCode) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.repository[languageCode.toLowerCase()]
    } else {
      this.repository = {}
    }
  }

  availableLocales(): LanguageCode[] {
    return Object.keys(this.repository)
  }

  resourceKeys(languageCode: LanguageCode): string[] {
    const language = languageCode.toLowerCase()
    return Object.keys(this.repository[language] || {})
  }

  missingKeys(languageOfInterest: LanguageCode, referenceLanguage = this.config.defaultLanguage): string[] {
    const interest = this.resourceKeys(languageOfInterest)
    const reference = this.resourceKeys(referenceLanguage)

    return reference.filter(ref => !interest.includes(ref))
  }

  overspecifiedKeys(languageOfInterest: LanguageCode, referenceLanguage = this.config.defaultLanguage): string[] {
    return this.missingKeys(referenceLanguage, languageOfInterest)
  }

  translationProgress(languageOfInterest: LanguageCode, referenceLanguage = this.config.defaultLanguage): number {
    const reference = this.resourceKeys(referenceLanguage).length
    const missing = this.missingKeys(languageOfInterest, referenceLanguage).length

    return (reference - missing) / reference
  }

  createContext(languageCode: LanguageCode, templateData: Readonly<TemplateData>): I18nContext {
    return new I18nContext(this.repository, this.config, languageCode, templateData)
  }

  middleware(): MiddlewareFn<TelegrafContextWithI18n> {
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    return async (ctx, next) => {
      const session: Session | undefined = this.config.useSession && (ctx as any)[this.config.sessionName]
      const languageCode = session?.__language_code ?? ctx.from?.language_code ?? this.config.defaultLanguage

      ctx.i18n = new I18nContext(
        this.repository,
        this.config,
        languageCode,
        {
          from: ctx.from,
          chat: ctx.chat
        }
      )

      await next()

      if (session) {
        session.__language_code = ctx.i18n.locale()
      }
    }
  }

  t(languageCode: LanguageCode, resourceKey: string, templateData: Readonly<TemplateData> = {}): string {
    return this.createContext(languageCode, templateData).t(resourceKey)
  }
}

function compileTemplates(root: Readonly<Record<string, string>>): RepositoryEntry {
  const result: RepositoryEntry = {}

  for (const [key, value] of Object.entries(root)) {
    if (value.includes('${')) {
      result[key] = compile(value)
    } else {
      result[key] = () => value
    }
  }

  return result
}

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

export function match(resourceKey: string, templateData: Readonly<TemplateData>): (text: string, ctx: TelegrafContextWithI18n) => string[] | null {
  return (text, ctx) => (text && ctx?.i18n && text === ctx.i18n.t(resourceKey, templateData)) ? [text] : null
}

export function reply(resourceKey: string, extra?: ExtraReplyMessage): (ctx: TelegrafContextWithI18n) => Promise<Message> {
  return async ctx => ctx.reply(ctx.i18n.t(resourceKey), extra)
}

/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
