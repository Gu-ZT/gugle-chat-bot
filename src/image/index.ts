import nodeHtmlToImage from 'node-html-to-image';
import fs from 'node:fs';
import Constants from '@/constants';

export class Template {
  private readonly templatePath: string;
  private readonly templateName: string;
  private processor: ((template: string) => string)[] = [];

  public constructor(templateName: string, templatePath: string) {
    this.templateName = templateName;
    this.templatePath = templatePath;
  }

  public static load(templateName: string, templatePath: string = 'src/template'): Template {
    return new Template(templateName, templatePath);
  }

  private async loadTemplate(templateName: string, templatePath: string): Promise<string> {
    return fs.readFileSync(`${templatePath}/${templateName}.html`, 'utf8');
  }

  private async loadStyleSheet(templateName: string, templatePath: string): Promise<string> {
    try {
      return fs.readFileSync(`${templatePath}/style/${templateName}.css`, 'utf8');
    } catch (e) {
      return '';
    }
  }

  public arg(param: string, object: any): Template {
    this.processor.push(template => {
      while (template.includes(`{{${param}}}`)) {
        template = template.replace(`{{${param}}}`, object.toString());
      }
      return template;
    });
    return this;
  }

  public handler(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.loadTemplate(this.templateName, this.templatePath)
        .then(template => {
          this.loadStyleSheet(this.templateName, this.templatePath).then(styleSheet => {
            try {
              this.processor.forEach(processor => {
                template = processor(template);
              });
              template = template.replace('{{style sheet}}', `<style>\n${styleSheet}\n</style>`);
              resolve(template);
            } catch (e) {
              reject(e);
            }
          });
        })
        .catch(reject);
    });
  }
}

function imageToBase64(image: Buffer<ArrayBufferLike>) {
  return image.toString('base64');
}

export function tryGenerateImage(
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: any) => void,
  html: string,
  width: number = 820
) {
  try {
    nodeHtmlToImage({
      html: html,
      puppeteerArgs: {
        executablePath: Constants.CHROME_PATH,
        defaultViewport: {
          width: width,
          height: 1
        },
        timeout: 60000,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions'
        ]
      },
      type: 'png',
      timeout: 60000
    })
      .then(image => {
        // const outputPath = path.join(process.cwd(), 'output.png');
        // fs.writeFileSync(outputPath, image as Buffer);
        // console.log(`图片已保存到: ${outputPath}`);
        resolve(imageToBase64(image as Buffer));
      })
      .catch(reject);
  } catch (e) {
    reject(e);
  }
}
