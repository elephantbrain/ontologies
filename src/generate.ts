import * as fs from "fs"
import Handlebars from "handlebars"
import {
  Project,
  StatementStructures,
  StructureKind,
  SyntaxKind,
  ts,
  VariableDeclarationKind,
} from 'ts-morph'
import { ScriptTarget } from "typescript/lib/tsserverlibrary"

import defaults from "../templates/defaults.package.json"
import { packageTSIndexFile } from "./helpers"
import {
  Ontology,
  OntologyItem,
  OntologyItemPropType,
  OntologyTerm,
} from './types'

const RESERVED_KEYWORDS = [
  // Not JS spec, but reserved for custom terms
  'ns',

  // From https://www.w3schools.com/js/js_reserved.asp
  'abstract',
  'arguments',
  'await',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'function',
  'goto',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'int',
  'interface',
  'let',
  'long',
  'native',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'volatile',
  'while',
  'with',
  'yield',

  'eval',
  'function',
  'hasOwnProperty',
  'Infinity',
  'isFinite',
  'isNaN',
  'isPrototypeOf',
  'NaN',
  /** Causes problems in Nodejs */
  'Object',
  'prototype',
  'undefined',
  'valueOf',
];

const UNSAFE_TOKENS = ['-']

const firstValue = (obj: OntologyItem, property: string): OntologyItemPropType => {
  if (typeof obj === "object" && obj !== null && property in obj) {
    const prop = obj[property]

    return Array.isArray(prop) ? prop[0] : prop
  }

  return undefined
}

export async function generate(ontologies: Ontology[]): Promise<Ontology[]> {
  const packages = new Project()

  const readmeTemplate = Handlebars.compile(fs.readFileSync("./templates/readme.template.md").toString('utf-8'))

  for (const ontology of ontologies) {
    const safeTermSymbol = (term: string) => {
      if (RESERVED_KEYWORDS.includes(term)) {
        return `${ontology.symbol}${term.replace('-', '_')}`
      }

      return term.replace('-', '_')
    }

    const packageJSON = Object.assign(
      {},
      defaults,
      {
        name: `@ontologies/${ontology.symbol}`,
        description: firstValue(ontology, 'label'),
        version: ontology.version || defaults.version
      }
    )
    packages.createSourceFile(
      `packages/${ontology.symbol}/package.json`,
      JSON.stringify(packageJSON, null, 2)
    )

    packages.createSourceFile(
      `packages/${ontology.symbol}/README.md`,
      readmeTemplate({
        ...ontology,
        ...packageJSON,
        humanName: ontology.name,
        ontologiesRepo: 'https://github.com/ontola/ontologies',
        ns: ontology.ns.value,
        termCount: ontology.classes.length + ontology.properties.length + ontology.otherTerms.length,
        classCount: ontology.classes.length,
        propertyCount: ontology.properties.length,
        otherTermCount: ontology.otherTerms.length,
      })
    )

    const rdfImport: StatementStructures = {
      kind: StructureKind.ImportDeclaration,
      moduleSpecifier: "@ontologies/core",
      namedImports: [
        {
          name: "createNS"
        }
      ]
    };

    const nsCommentText = `Function to create arbitrary terms within the '${ontology.name}' ontology`
    const ns: StatementStructures = {
      kind: StructureKind.VariableStatement,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [
        {
          kind: StructureKind.VariableDeclaration,
          name: "ns",
          initializer: `createNS("${ontology.ns.value}")`,
        }
      ],
      isExported: true,
      leadingTrivia: `/** ${nsCommentText} */\n`
    }

    const structureForTerm = (term: OntologyTerm): StatementStructures => ({
      kind: StructureKind.VariableStatement,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [
        {
          kind: StructureKind.VariableDeclaration,
          name: safeTermSymbol(term.term),
          initializer: `ns("${term.term}")`,
        }
      ],
      leadingTrivia: (term.comment && term.comment[0])
        ? `/** ${term.comment[0].value} */\n`
        : undefined,
      isExported: true
    })

    const classes = ontology.classes.map(structureForTerm)
    const properties = ontology.properties.map(structureForTerm)
    const otherTerms = ontology.otherTerms.map(structureForTerm)

    const shorthandNSDefaultExport = ts.createShorthandPropertyAssignment('ns')
    ts.addSyntheticLeadingComment(
      shorthandNSDefaultExport,
      SyntaxKind.MultiLineCommentTrivia,
      `* ${nsCommentText} `,
      true
    )

    const shorthandTermsDefaultExport = [
      ...ontology.classes,
      ...ontology.properties,
      ...ontology.otherTerms,
    ].flatMap<ts.PropertyAssignment | ts.ShorthandPropertyAssignment>((property) => {
        const safeTerm = safeTermSymbol(property.term)
        const comment = (property.comment && property.comment[0])
          ? `* ${property.comment[0].value} `
          : undefined

        if (safeTerm !== property.term) {
          const nonValidIdentifier = UNSAFE_TOKENS.some((token) => property.term.includes(token))

          const exactPropertyName = nonValidIdentifier
            ? ts.createComputedPropertyName(ts.createLiteral(property.term))
            : property.term
          const exactPropertyNameNode = ts.createPropertyAssignment(exactPropertyName, ts.createIdentifier(safeTerm))
          if (comment) {
            ts.addSyntheticLeadingComment(
              exactPropertyNameNode,
              SyntaxKind.MultiLineCommentTrivia,
              comment,
              true
            )
          }

          const validIdentifierPropertyName = nonValidIdentifier
            ? ts.createPropertyAssignment(safeTerm, ts.createIdentifier(safeTerm))
            : undefined
          if (validIdentifierPropertyName && comment) {
            ts.addSyntheticLeadingComment(
              validIdentifierPropertyName,
              SyntaxKind.MultiLineCommentTrivia,
              comment,
              true
            )
          }

          return [
            validIdentifierPropertyName,
            exactPropertyNameNode,
          ].filter(Boolean) as Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment>
        }

        const test = ts.createShorthandPropertyAssignment(safeTerm);
        if (comment) {
          ts.addSyntheticLeadingComment(test, SyntaxKind.MultiLineCommentTrivia, comment, true)
        }
        return test
      })

    const defaultExportSymbols: Array<ts.ShorthandPropertyAssignment | ts.PropertyAssignment> = [
      shorthandNSDefaultExport,
      ...shorthandTermsDefaultExport,
    ]

    const defaultExport = ts.createExportDefault(ts.createObjectLiteral(defaultExportSymbols, true))

    const printer = ts.createPrinter({
      omitTrailingSemicolon: false,
    })

    const defaultExportPrintedNode = printer.printNode(
      ts.EmitHint.Unspecified,
      defaultExport,
      ts.createSourceFile("", "", ScriptTarget.ES2019)
    )

    packages.createSourceFile(
      packageTSIndexFile(ontology),
      {
        statements: [
          rdfImport,
          "\n\n",
          ns,
          "\n\n/* Classes */\n",
          ...classes,
          "\n\n/* Properties */\n",
          ...properties,
          "\n\n/* Other terms */\n",
          ...otherTerms,
          "\n\n",
          defaultExportPrintedNode
        ]
      }
    )
  }

  await packages.save()

  return ontologies
}
