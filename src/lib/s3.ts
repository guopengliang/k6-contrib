import { extname } from 'path';
import { FileUpload } from 'graphql-upload';
import AWS from 'aws-sdk';
import urlJoin from 'url-join';
import cuid from 'cuid';
import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import sharp from 'sharp';
import { ImageExtension, KeystoneContext } from '@keystone-next/types';
import { AssetType, S3ImagesConfig, ImagesData } from './types';
import { parseImageRef } from './utils';

const defaultTransformer = (str: string) => slugify(str);

const generateSafeFilename = (
  filename: string,
  transformFilename: (str: string) => string = defaultTransformer
) => {
  // Appends a UUID to the filename so that people can't brute-force guess stored filenames
  //
  // This regex lazily matches for any characters that aren't a new line
  // it then optionally matches the last instance of a "." symbol
  // followed by any alphabetical character before the end of the string
  const [, name, ext] = filename.match(/^([^:\n].*?)(\.[A-Za-z]+)?$/) as RegExpMatchArray;

  const id = cuid();

  const urlSafeName = filenamify(transformFilename(name), {
    maxLength: 100 - id.length,
    replacement: '-',
  });
  if (ext) {
    return `${urlSafeName}-${id}${ext}`;
  }
  return `${urlSafeName}-${id}`;
};

const getFilename = ({ id, size, extension }: ImagesData) => `${id}_${size}.${extension}`;

const defaultGetSrc = ({ bucket, folder }: S3ImagesConfig, fileData: ImagesData) => {
  const filename = getFilename(fileData);
  return urlJoin(`https://${bucket}.s3.amazonaws.com`, folder as string, filename);
};

export function getSrc(config: S3ImagesConfig, fileData: ImagesData) {
  if (config.baseUrl) {
    return urlJoin(config.baseUrl, getFilename(fileData));
  }
  return config.getSrc?.(config, fileData) || defaultGetSrc(config, fileData);
}

export const getDataFromStream = async (
  config: S3ImagesConfig,
  upload: FileUpload,
  context: KeystoneContext,
): Promise<ImagesData> => {
  const { createReadStream, encoding, filename: originalFilename, mimetype } = upload;
  const filename = generateSafeFilename(originalFilename, config.transformFilename);

  const extension = extname(originalFilename) as ImageExtension;
  const s3 = new AWS.S3(config.s3Options);

  const imagePipeline = sharp();
  createReadStream().pipe(imagePipeline)
  const metadata = await imagePipeline.metadata();

  const fileId = cuid();
  const id = config.getFilename?.({ id: fileId, originalFilename, context }) || fileId;
  const fileData: ImagesData = {
    id,
    height: metadata.height as number,
    width: metadata.width as number,
    filesize: metadata.size as number,
    extension,
    size: 'full',
  };
  fileData.sizesMeta = { full: { ...fileData } };


  // upload full image
  const uploadParams = config.uploadParams?.(fileData) || {};
  await s3
    .upload({
      Body: createReadStream(),
      ContentType: mimetype,
      Bucket: config.bucket,
      Key: `${config.folder}/${getFilename(fileData)}`,
      Metadata: {
        'x-amz-meta-original-filename': originalFilename,
        'x-amz-meta-image-height': `${metadata.height}`,
        'x-amz-meta-image-width': `${metadata.width}`,
      },
      ...uploadParams,
    })
    .promise();

  // upload sm image
  const smFile = await imagePipeline.clone().resize(360).toBuffer({ resolveWithObject: true });
  const smFileData: ImagesData = {
    id,
    height: smFile.info.height,
    width: smFile.info.width,
    filesize: smFile.info.size,
    extension,
    size: 'sm',
  }
  fileData.sizesMeta.sm = smFileData;

  await s3
    .upload({
      Body: smFile.data,
      ContentType: mimetype,
      Bucket: config.bucket,
      Key: `${config.folder}/${getFilename(smFileData)}`,
      Metadata: {
        'x-amz-meta-original-filename': originalFilename,
        'x-amz-meta-image-height': `${smFileData.height}`,
        'x-amz-meta-image-width': `${smFileData.width}`,
      },
      ...uploadParams,
    })
    .promise();
  // upload md image

  const mdFile = await imagePipeline.clone().resize(720).toBuffer({ resolveWithObject: true });
  const mdFileData: ImagesData = {
    id,
    height: mdFile.info.height,
    width: mdFile.info.width,
    filesize: mdFile.info.size,
    extension,
    size: 'sm',
  }
  fileData.sizesMeta.md = mdFileData;

  await s3
    .upload({
      Body: mdFile.data,
      ContentType: mimetype,
      Bucket: config.bucket,
      Key: `${config.folder}/${getFilename(mdFileData)}`,
      Metadata: {
        'x-amz-meta-original-filename': originalFilename,
        'x-amz-meta-image-height': `${mdFileData.height}`,
        'x-amz-meta-image-width': `${mdFileData.width}`,
      },
      ...uploadParams,
    })
    .promise();
  // upload lg image
  const lgFile = await imagePipeline.clone().resize(1080).toBuffer({ resolveWithObject: true });
  const lgFileData: ImagesData = {
    id,
    height: lgFile.info.height,
    width: lgFile.info.width,
    filesize: lgFile.info.size,
    extension,
    size: 'sm',
  }
  fileData.sizesMeta.lg = lgFileData;

  await s3
    .upload({
      Body: lgFile.data,
      ContentType: mimetype,
      Bucket: config.bucket,
      Key: `${config.folder}/${getFilename(lgFileData)}`,
      Metadata: {
        'x-amz-meta-original-filename': originalFilename,
        'x-amz-meta-image-height': `${lgFileData.height}`,
        'x-amz-meta-image-width': `${lgFileData.width}`,
      },
      ...uploadParams,
    })
    .promise();
  fileData.sizesMeta.lg = lgFileData;

  return fileData;
};

export const getDataFromRef = async (
  config: S3ImagesConfig,
  type: AssetType,
  ref: string
): Promise<ImagesData> => {
  const fileRef = parseImageRef(ref);

  if (!fileRef) {
    throw new Error('Invalid image reference');
  }

  const s3 = new AWS.S3(config.s3Options);

  // get data from S3 for current size
  const sizesMeta = {
    [fileRef.size]: await getS3ImageMeta(s3, config, fileRef as ImagesData),
  };

  for (const size of ['sm', 'md', 'lg', 'full'].filter(item => item !== fileRef.size)) {
    sizesMeta[size] = await getS3ImageMeta(s3, config, { ...fileRef, size } as ImagesData);
  }

  return {
    ...sizesMeta.full,
    sizesMeta,
  }
};

async function getS3ImageMeta(s3: AWS.S3, config: S3ImagesConfig, fileData: ImagesData) {
  const result = await s3
    .headObject({
      Bucket: config.bucket,
      Key: urlJoin(config.folder as string, getFilename(fileData)),
    })
    .promise();
  return {
    ...fileData,
    height: Number(result.Metadata?.['x-amz-meta-image-height'] || 0),
    width: Number(result.Metadata?.['x-amz-meta-image-width'] || 0),
    filesize: result.ContentLength || 0,
  };
}
