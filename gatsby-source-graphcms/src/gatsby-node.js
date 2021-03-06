const crypto = require('crypto')
const fs = require('fs')
const {
  wrapQueryExecutorWithQueue,
  loadSchema,
  readOrGenerateDefaultFragments,
  compileNodeQueries,
  buildNodeDefinitions,
  createSchemaCustomization,
  sourceAllNodes,
  sourceNodeChanges,
} = require('gatsby-graphql-source-toolkit')
const { createRemoteFileNode } = require('gatsby-source-filesystem')
const he = require('he')
const fetch = require('node-fetch')

exports.pluginOptionsSchema = ({ Joi }) => {
  return Joi.object({
    buildMarkdownNodes: Joi.boolean()
      .description(
        `Build markdown nodes for all [RichText](https://graphcms.com/docs/reference/fields/rich-text) fields in your GraphCMS schema`
      )
      .default(false),
    downloadLocalImages: Joi.boolean()
      .description(
        `Download and cache GraphCMS image assets in your Gatsby project`
      )
      .default(false),
    endpoint: Joi.string()
      .description(
        `The endpoint URL for the GraphCMS project. This can be found in the [project settings UI](https://graphcms.com/docs/guides/concepts/apis#working-with-apis)`
      )
      .required(),
    fragmentsPath: Joi.string()
      .description(
        `The local project path where generated query fragments are saved. This is relative to your current working directory. If using multiple instances of the source plugin, you **must** provide a value here to prevent type and/or fragment conflicts.`
      )
      .default(`graphcms-fragments`),
    locales: Joi.array()
      .description(
        `An array of locale key strings from your GraphCMS project. You can read more about working with localisation in GraphCMS [here](https://graphcms.com/docs/guides/concepts/i18n).`
      )
      .items(Joi.string())
      .default(['en']),
    token: Joi.string().description(
      `If your GraphCMS project is **not** publicly accessible, you will need to provide a [Permanent Auth Token](https://graphcms.com/docs/reference/authorization) to correctly authorize with the API. You can learn more about creating and managing API tokens [here](https://graphcms.com/docs/guides/concepts/apis#working-with-apis)`
    ),
    typePrefix: Joi.string()
      .description(
        `The string by which every generated type name is prefixed with. For example, a type of Post in GraphCMS would become GraphCMS_Post by default. If using multiple instances of the source plugin, you **must** provide a value here to prevent type conflicts`
      )
      .default(`GraphCMS_`),
  })
}

exports.onPreBootstrap = ({ reporter }, pluginOptions) => {
  if (!pluginOptions || !pluginOptions.endpoint)
    return reporter.panic(
      'gatsby-source-graphcms: You must provide your GraphCMS endpoint URL'
    )

  if (
    pluginOptions.locales &&
    (!Array.isArray(pluginOptions.locales) ||
      pluginOptions.locales.length === 0)
  )
    return reporter.panic(
      `gatsby-source-graphcms: Please provide a valid array of locale key strings (i.e. [
        ('en', 'de')
      ]`
    )
}

const createSourcingConfig = async (
  gatsbyApi,
  {
    endpoint,
    fragmentsPath = 'graphcms-fragments',
    locales = ['en'],
    token,
    typePrefix = 'GraphCMS_',
  }
) => {
  const execute = async ({ operationName, query, variables = {} }) => {
    const { reporter } = gatsbyApi

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ query, variables, operationName }),
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    })

    if (!response.ok)
      return reporter.panic(
        `gatsby-source-graphcms: Problem building GraphCMS nodes`,
        new Error(response.statusText)
      )

    return await response.json()
  }
  const schema = await loadSchema(execute)

  const nodeInterface = schema.getType('Node')
  const query = schema.getType('Query')
  const queryFields = query.getFields()
  const possibleTypes = schema.getPossibleTypes(nodeInterface)

  const singularRootFieldName = (type) =>
    Object.keys(queryFields).find(
      (fieldName) => queryFields[fieldName].type === type
    )

  const pluralRootFieldName = (type) =>
    Object.keys(queryFields).find(
      (fieldName) => String(queryFields[fieldName].type) === `[${type.name}!]!`
    )

  const hasLocaleField = (type) => type.getFields().locale

  const gatsbyNodeTypes = possibleTypes.map((type) => ({
    remoteTypeName: type.name,
    queries: [
      ...locales.map(
        (locale) => `
        query LIST_${pluralRootFieldName(
          type
        )}_${locale} { ${pluralRootFieldName(type)}(first: $limit, ${
          hasLocaleField(type) ? `locales: [${locale}]` : ''
        }, skip: $offset) {
            ..._${type.name}Id_
          }
        }`
      ),
      `query NODE_${singularRootFieldName(type)}{ ${singularRootFieldName(
        type
      )}(where: $where, ${hasLocaleField(type) ? `locales: $locales` : ''}) {
        ..._${type.name}Id_
        }
      }
      fragment _${type.name}Id_ on ${type.name} {
        __typename
        id
        ${hasLocaleField(type) ? `locale` : ''}
      }`,
    ].join('\n'),
    nodeQueryVariables: ({ id, locale }) => ({
      where: { id },
      locales: [locale],
    }),
  }))

  const fragmentsDir = `${process.cwd()}/${fragmentsPath}`

  if (!fs.existsSync(fragmentsDir)) fs.mkdirSync(fragmentsDir)

  const addSystemFieldArguments = (field) => {
    if (['createdAt', 'publishedAt', 'updatedAt'].includes(field.name))
      return { variation: `COMBINED` }
  }

  const fragments = await readOrGenerateDefaultFragments(fragmentsDir, {
    schema,
    gatsbyNodeTypes,
    defaultArgumentValues: [addSystemFieldArguments],
  })

  const documents = compileNodeQueries({
    schema,
    gatsbyNodeTypes,
    customFragments: fragments,
  })

  return {
    gatsbyApi,
    schema,
    execute: wrapQueryExecutorWithQueue(execute, { concurrency: 10 }),
    gatsbyTypePrefix: typePrefix,
    gatsbyNodeDefs: buildNodeDefinitions({ gatsbyNodeTypes, documents }),
  }
}

exports.sourceNodes = async (gatsbyApi, pluginOptions) => {
  const { webhookBody } = gatsbyApi

  const config = await createSourcingConfig(gatsbyApi, pluginOptions)

  await createSchemaCustomization(config)

  if (webhookBody && Object.keys(webhookBody).length) {
    const { operation, data } = webhookBody

    const nodeEvent = (operation, { __typename, locale, id }) => {
      switch (operation) {
        case 'delete':
        case 'unpublish':
          return {
            eventName: 'DELETE',
            remoteTypeName: __typename,
            remoteId: { __typename, locale, id },
          }
        case 'create':
        case 'publish':
        case 'update':
          return {
            eventName: 'UPDATE',
            remoteTypeName: __typename,
            remoteId: { __typename, locale, id },
          }
      }
    }

    const { localizations = [{ locale: 'en' }] } = data

    await sourceNodeChanges(config, {
      nodeEvents: localizations.map(({ locale }) =>
        nodeEvent(operation, { locale, ...data })
      ),
    })
  } else {
    await sourceAllNodes(config)
  }
}

exports.onCreateNode = async (
  { node, actions: { createNode }, createNodeId, getCache },
  {
    buildMarkdownNodes = false,
    downloadLocalImages = false,
    typePrefix = 'GraphCMS_',
  }
) => {
  if (
    downloadLocalImages &&
    node.remoteTypeName === 'Asset' &&
    node.mimeType.includes('image/')
  ) {
    try {
      const fileNode = await createRemoteFileNode({
        url: node.url,
        parentNodeId: node.id,
        createNode,
        createNodeId,
        getCache,
      })

      if (fileNode) node.localFile = fileNode.id
    } catch (e) {
      console.error('gatsby-source-graphcms:', e)
    }
  }

  if (buildMarkdownNodes) {
    const fields = Object.entries(node)
      .map(([key, value]) => ({ key, value }))
      .filter(
        ({ value }) =>
          value && value.remoteTypeName && value.remoteTypeName === 'RichText'
      )

    if (fields.length) {
      fields.forEach((field) => {
        const decodedMarkdown = he.decode(field.value.markdown)

        const markdownNode = {
          id: `MarkdownNode:${createNodeId(`${node.id}-${field.key}`)}`,
          parent: node.id,
          internal: {
            type: `${typePrefix}MarkdownNode`,
            mediaType: 'text/markdown',
            content: decodedMarkdown,
            contentDigest: crypto
              .createHash(`md5`)
              .update(decodedMarkdown)
              .digest(`hex`),
          },
        }

        createNode(markdownNode)

        field.value.markdownNode = markdownNode.id
      })
    }
  }
}

exports.createSchemaCustomization = (
  { actions: { createTypes } },
  {
    buildMarkdownNodes = false,
    downloadLocalImages = false,
    typePrefix = 'GraphCMS_',
  }
) => {
  if (downloadLocalImages)
    createTypes(`
      type ${typePrefix}Asset {
        localFile: File @link
      }
    `)

  if (buildMarkdownNodes)
    createTypes(`
      type ${typePrefix}MarkdownNode implements Node {
        id: ID!
      }
      type ${typePrefix}RichText {
        markdownNode: ${typePrefix}MarkdownNode @link
      }
    `)
}
