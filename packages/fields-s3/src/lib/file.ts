import path from 'path';

import {
  BaseGeneratedListTypes,
  fieldType,
  FieldTypeFunc,
  KeystoneContext,
  schema,
} from '@keystone-next/types';
import { getFileRef } from './utils';
import { S3FieldConfig, S3FieldInputType, S3Config, S3DataType, FileData } from './types';
import { getDataFromRef, getDataFromStream, getSrc } from './s3';

const views = path.join(
  path.dirname(require.resolve('@k6-contrib/fields-s3/package.json')),
  'views/file'
);

const S3FileFieldInput = schema.inputObject({
  name: 'S3FileFieldInput',
  fields: {
    upload: schema.arg({ type: schema.Upload }),
    ref: schema.arg({ type: schema.String }),
  },
});

function createInputResolver(config: S3Config) {
  return async function inputResolver(data: S3FieldInputType, context: KeystoneContext) {
    if (data === null || data === undefined) {
      return { filename: data, filesize: data };
    }

    if (data.ref) {
      if (data.upload) {
        throw new Error('Only one of ref and upload can be passed to S3FileFieldInput');
      }
      return getDataFromRef(config, 'file', data.ref) as any;
    }
    if (!data.upload) {
      throw new Error('Either ref or upload must be passed to FileFieldInput');
    }
    return getDataFromStream(config, 'file', await data.upload);
  };
}

export const s3File = <TGeneratedListTypes extends BaseGeneratedListTypes>({
  isRequired,
  defaultValue,
  s3Config,
  ...config
}: S3FieldConfig<TGeneratedListTypes>): FieldTypeFunc => () => {
  if ((config as any).isUnique) {
    throw Error('isUnique is not a supported option for field type file');
  }

  const fileOutputFields = schema.fields<Omit<FileData, 'type'>>()({
    filename: schema.field({ type: schema.nonNull(schema.String) }),
    filesize: schema.field({ type: schema.nonNull(schema.Int) }),
    ref: schema.field({
      type: schema.nonNull(schema.String),
      resolve(data) {
        return getFileRef(data.filename);
      },
    }),
    src: schema.field({
      type: schema.nonNull(schema.String),
      resolve(data, args, context) {
        return getSrc(s3Config as S3Config, { type: 'file', ...data } as S3DataType);
      },
    }),
  });

  const S3FileFieldOutput = schema.interface<Omit<FileData, 'type'>>()({
    name: 'S3FileFieldOutput',
    fields: fileOutputFields,
    resolveType: () => 'S3FileFieldOutputType',
  });

  const S3FileFieldOutputType = schema.object<Omit<FileData, 'type'>>()({
    name: 'S3FileFieldOutputType',
    interfaces: [S3FileFieldOutput],
    fields: fileOutputFields,
  });

  return fieldType({
    kind: 'multi',
    fields: {
      filename: { kind: 'scalar', scalar: 'String', mode: 'optional' },
      filesize: { kind: 'scalar', scalar: 'Int', mode: 'optional' },
    },
  })({
    ...config,
    input: {
      create: {
        arg: schema.arg({ type: S3FileFieldInput }),
        resolve: createInputResolver(s3Config as S3Config),
      },
      update: {
        arg: schema.arg({ type: S3FileFieldInput }),
        resolve: createInputResolver(s3Config as S3Config),
      },
    },
    output: schema.field({
      type: S3FileFieldOutput,
      resolve({ value: { filename, filesize } }) {
        if (filename === null || filesize === null) {
          return null;
        }
        return { filename, filesize };
      },
    }),
    unreferencedConcreteInterfaceImplementations: [S3FileFieldOutputType],
    views,
    __legacy: {
      isRequired,
      defaultValue,
    },
  });
};
