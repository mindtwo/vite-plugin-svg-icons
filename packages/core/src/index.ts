import type { Plugin } from 'vite'
import type { OptimizedSvg, OptimizeOptions } from 'svgo'
import type { ViteSvgIconsPlugin, FileStats, DomInject } from './typing'
import fg from 'fast-glob'
import getEtag from 'etag'
import cors from 'cors'
import fs from 'fs-extra'
import path from 'pathe'
import Debug from 'debug'
import SVGCompiler from 'svg-baker'
import { optimize } from 'svgo'
import { normalizePath } from 'vite'
import {
  SVG_DOM_ID,
  SVG_ICONS_CLIENT,
  SVG_ICONS_REGISTER_NAME,
  ICON_NAME_LOOKUPS,
  XMLNS,
  XMLNS_LINK,
} from './constants'

export * from './typing'

const debug = Debug.debug('vite-plugin-svg-icons')

export function createSvgIconsPlugin(opt: ViteSvgIconsPlugin): Plugin {
  const cache = new Map<string, FileStats>()

  let isBuild = false
  const options = {
    svgoOptions: true,
    symbolId: 'icon-[dir]-[name]',
    inject: 'body-last' as const,
    customDomId: SVG_DOM_ID,
    iconNameLookups: ICON_NAME_LOOKUPS,
    ...opt,
  }

  let { svgoOptions } = options
  const { symbolId } = options

  if (!symbolId.includes('[name]')) {
    throw new Error('SymbolId must contain [name] string!')
  }

  if (svgoOptions) {
    svgoOptions = typeof svgoOptions === 'boolean' ? {} : svgoOptions
  }

  debug('plugin options:', options)

  return {
    name: 'vite:svg-icons',
    configResolved(resolvedConfig) {
      isBuild = resolvedConfig.command === 'build'
      debug('resolvedConfig:', resolvedConfig)
    },
    resolveId(id) {
      if ([SVG_ICONS_REGISTER_NAME, SVG_ICONS_CLIENT].includes(id)) {
        return id
      }
      return null
    },

    async load(id, ssr) {
      if (!isBuild && !ssr) return null

      const isRegister = id.endsWith(SVG_ICONS_REGISTER_NAME)
      const isClient = id.endsWith(SVG_ICONS_CLIENT)

      if (ssr && !isBuild && (isRegister || isClient)) {
        return `export default {}`
      }

      const { code, idSet } = await createModuleCode(
        cache,
        svgoOptions as OptimizeOptions,
        options,
      )
      if (isRegister) {
        return code
      }
      if (isClient) {
        return idSet
      }
    },
    configureServer: ({ middlewares }) => {
      middlewares.use(cors({ origin: '*' }))
      middlewares.use(async (req, res, next) => {
        const url = normalizePath(req.url!)

        const registerId = `/@id/${SVG_ICONS_REGISTER_NAME}`
        const clientId = `/@id/${SVG_ICONS_CLIENT}`
        if ([clientId, registerId].some((item) => url.endsWith(item))) {
          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          const { code, idSet } = await createModuleCode(
            cache,
            svgoOptions as OptimizeOptions,
            options,
          )
          const content = url.endsWith(registerId) ? code : idSet

          res.setHeader('Etag', getEtag(content, { weak: true }))
          res.statusCode = 200
          res.end(content)
        } else {
          next()
        }
      })
    },
  }
}

export async function createModuleCode(
  cache: Map<string, FileStats>,
  svgoOptions: OptimizeOptions,
  options: ViteSvgIconsPlugin,
) {
  let usedIds = new Set<string>()

  if (options.iconNameLookups) {
    usedIds = await collectUsedIcons(cache, options)
  }

  const { insertHtml, idSet } = await compilerIcons(cache, svgoOptions, options, usedIds)

  const xmlns = `xmlns="${XMLNS}"`
  const xmlnsLink = `xmlns:xlink="${XMLNS_LINK}"`
  const html = insertHtml
    .replace(new RegExp(xmlns, 'g'), '')
    .replace(new RegExp(xmlnsLink, 'g'), '')

  const code = `
       if (typeof window !== 'undefined') {
         function loadSvg() {
           var body = document.body;
           var svgDom = document.getElementById('${options.customDomId}');
           if(!svgDom) {
             svgDom = document.createElementNS('${XMLNS}', 'svg');
             svgDom.style.position = 'absolute';
             svgDom.style.width = '0';
             svgDom.style.height = '0';
             svgDom.id = '${options.customDomId}';
             svgDom.setAttribute('xmlns','${XMLNS}');
             svgDom.setAttribute('xmlns:link','${XMLNS_LINK}');
           }
           svgDom.innerHTML = ${JSON.stringify(html)};
           ${domInject(options.inject)}
         }
         if(document.readyState === 'loading') {
           document.addEventListener('DOMContentLoaded', loadSvg);
         } else {
           loadSvg()
         }
      }
        `
  return {
    code: `${code}\nexport default {}`,
    idSet: `export default ${JSON.stringify(Array.from(idSet))}`,
  }
}

function domInject(inject: DomInject = 'body-last') {
  switch (inject) {
    case 'body-first':
      return 'body.insertBefore(svgDom, body.firstChild);'
    default:
      return 'body.insertBefore(svgDom, body.lastChild);'
  }
}

async function collectUsedIcons(cache: Map<string, FileStats>, options: ViteSvgIconsPlugin) {

  const { iconNameLookups } = options

  const vueFileStats = fg.sync('**/*.vue', {
    cwd: path.resolve(process.cwd(), 'src'),
    stats: true,
    absolute: true,
  })

  const usedIdSet = new Set<string>()
  let relativeName = ''

  for (const entry of vueFileStats) {
    const { path, stats: { mtimeMs } = {} } = entry

    const getIconIds = async () => {
      relativeName = normalizePath(path).replace(normalizePath('src' + '/'), '')

      const iconIds = new Array<string>()
      let content = fs.readFileSync(path, 'utf-8')
      const regex = getRegex(iconNameLookups as Array<string>)
      let m

      while ((m = regex.exec(content)) !== null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (m.index === regex.lastIndex) {
          regex.lastIndex++
        }

        let { groups: { iconId } } = m
        if (iconId) {
          const symbolId = createSymbolId(iconId, options)
          iconIds.push(symbolId)
        }
      }
      return iconIds
    }

    let iconIds
    const cacheStat = cache.get(path)
    if (cacheStat) {
      if (cacheStat.mtimeMs !== mtimeMs) {
        iconIds = await getIconIds()
      } else {
        iconIds = JSON.parse(cacheStat.code)
      }
    } else {
      iconIds = await getIconIds()
    }

    iconIds && iconIds.forEach(item => usedIdSet.add(item))

    iconIds &&
        cache.set(path, {
          mtimeMs,
          relativeName,
          code: JSON.stringify(iconIds),
        })

  }

  return usedIdSet
}

/**
 * Preload all icons in advance
 * @param cache
 * @param options
 */
export async function compilerIcons(
  cache: Map<string, FileStats>,
  svgOptions: OptimizeOptions,
  options: ViteSvgIconsPlugin,
  usedIds: Set<string>
) {
  const { iconDirs } = options

  let insertHtml = ''
  const idSet = new Set<string>()

  for (const dir of iconDirs) {
    const svgFilsStats = fg.sync('**/*.svg', {
      cwd: dir,
      stats: true,
      absolute: true,
    })

    for (const entry of svgFilsStats) {
      const { path, stats: { mtimeMs } = {} } = entry
      const cacheStat = cache.get(path)
      let svgSymbol
      let symbolId
      let relativeName = ''

      const getSymbol = async () => {
        relativeName = normalizePath(path).replace(normalizePath(dir + '/'), '')
        symbolId = createSymbolId(relativeName, options)
        svgSymbol = await compilerIcon(path, symbolId, svgOptions)
        idSet.add(symbolId)
      }

      if (cacheStat) {
        if (cacheStat.mtimeMs !== mtimeMs) {
          await getSymbol()
        } else {
          svgSymbol = cacheStat.code
          symbolId = cacheStat.symbolId
          if (symbolId && (usedIds.has(symbolId) || usedIds.size === 0)) {
            idSet.add(symbolId)
          }
        }
      } else {
        await getSymbol()
      }

      svgSymbol &&
        cache.set(path, {
          mtimeMs,
          relativeName,
          code: svgSymbol,
          symbolId,
        })

      if (usedIds && usedIds.size > 0) {
        if (!usedIds.has(symbolId)) {
          continue
        }
      }

      insertHtml += `${svgSymbol || ''}`
    }
  }

  return { insertHtml, idSet }
}

export async function compilerIcon(
  file: string,
  symbolId: string,
  svgOptions: OptimizeOptions,
): Promise<string | null> {
  if (!file) {
    return null
  }

  let content = fs.readFileSync(file, 'utf-8')

  if (svgOptions) {
    const { data } = (await optimize(content, svgOptions)) as OptimizedSvg
    content = data || content
  }

  // fix cannot change svg color  by  parent node problem
  content = content.replace(/stroke="[a-zA-Z#0-9]*"/, 'stroke="currentColor"')
  const svgSymbol = await new SVGCompiler().addSymbol({
    id: symbolId,
    content,
    path: file,
  })
  return svgSymbol.render()
}

export function createSymbolId(name: string, options: ViteSvgIconsPlugin) {
  const { symbolId } = options

  if (!symbolId) {
    return name
  }

  let id = symbolId
  let fName = name

  const { fileName = '', dirName } = discreteDir(name)
  if (symbolId.includes('[dir]')) {
    id = id.replace(/\[dir\]/g, dirName)
    if (!dirName) {
      id = id.replace('--', '-')
    }
    fName = fileName
  }
  id = id.replace(/\[name\]/g, fName)
  return id.replace(path.extname(id), '')
}

export function discreteDir(name: string) {
  if (!normalizePath(name).includes('/')) {
    return {
      fileName: name,
      dirName: '',
    }
  }
  const strList = name.split('/')
  const fileName = strList.pop()
  const dirName = strList.join('-')
  return { fileName, dirName }
}

function getRegex(iconNameLookups: Array<string>) {
  return new RegExp(`(${iconNameLookups.join('|')})\=\"(?<iconId>[A-Za-z0-9 _\-]*)\"`, 'gi')
}
