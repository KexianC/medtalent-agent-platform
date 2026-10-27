import {createCanvas,loadImage} from "@napi-rs/canvas";
const maximum=5242880;let size=0;const chunks=[];
try{
 for await(const chunk of process.stdin){size+=chunk.length;if(size>maximum)throw Error("too-large");chunks.push(chunk)}
 const image=await loadImage(Buffer.concat(chunks));
 if(image.width<1||image.height<1||image.width>8192||image.height>8192||image.width*image.height>16000000)throw Error("dimensions");
 const canvas=createCanvas(image.width,image.height);canvas.getContext("2d").drawImage(image,0,0);const png=await canvas.encode("png");
 if(png.length>maximum)throw Error("too-large");process.stdout.write(png);
}catch{process.exitCode=1}
