
// Neural Network Canvas Animation
class NeuralNetwork {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.connections = [];
        this.mouse = { x: 0, y: 0 };
        
        this.resize();
        this.init();
        this.animate();
        
        window.addEventListener('resize', () => this.resize());
        document.addEventListener('mousemove', (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
        });
    }
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    init() {
        const nodeCount = Math.floor((this.canvas.width * this.canvas.height) / 15000);
        
        for (let i = 0; i < nodeCount; i++) {
            this.nodes.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                vx: (Math.random() - 0.5) * 0.5,
                vy: (Math.random() - 0.5) * 0.5,
                radius: Math.random() * 3 + 1,
                connections: []
            });
        }
        
        // Create connections
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const distance = this.getDistance(this.nodes[i], this.nodes[j]);
                if (distance < 150) {
                    this.connections.push({
                        nodeA: this.nodes[i],
                        nodeB: this.nodes[j],
                        distance: distance
                    });
                }
            }
        }
    }
    
    getDistance(nodeA, nodeB) {
        return Math.sqrt(Math.pow(nodeB.x - nodeA.x, 2) + Math.pow(nodeB.y - nodeA.y, 2));
    }
    
    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Update and draw nodes
        this.nodes.forEach(node => {
            // Move nodes
            node.x += node.vx;
            node.y += node.vy;
            
            // Bounce off edges
            if (node.x <= 0 || node.x >= this.canvas.width) node.vx *= -1;
            if (node.y <= 0 || node.y >= this.canvas.height) node.vy *= -1;
            
            // Mouse interaction
            const mouseDistance = Math.sqrt(
                Math.pow(this.mouse.x - node.x, 2) + Math.pow(this.mouse.y - node.y, 2)
            );
            
            if (mouseDistance < 100) {
                const force = (100 - mouseDistance) / 100;
                const angle = Math.atan2(node.y - this.mouse.y, node.x - this.mouse.x);
                node.x += Math.cos(angle) * force * 2;
                node.y += Math.sin(angle) * force * 2;
            }
            
            // Draw node
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(0, 255, 255, ${0.6})`;
            this.ctx.fill();
            
            // Glow effect
            this.ctx.shadowBlur = 10;
            this.ctx.shadowColor = '#00ffff';
            this.ctx.fill();
            this.ctx.shadowBlur = 0;
        });
        
        // Draw connections
        this.connections.forEach(connection => {
            const distance = this.getDistance(connection.nodeA, connection.nodeB);
            const opacity = Math.max(0, (150 - distance) / 150) * 0.3;
            
            if (opacity > 0) {
                this.ctx.beginPath();
                this.ctx.moveTo(connection.nodeA.x, connection.nodeA.y);
                this.ctx.lineTo(connection.nodeB.x, connection.nodeB.y);
                this.ctx.strokeStyle = `rgba(0, 255, 255, ${opacity})`;
                this.ctx.lineWidth = 1;
                this.ctx.stroke();
            }
        });
        
        requestAnimationFrame(() => this.animate());
    }
}

// Initialize Neural Network
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('neural-canvas');
    new NeuralNetwork(canvas);
});

// Custom Cursor
class CustomCursor {
    constructor() {
        this.cursor = document.querySelector('.custom-cursor');
        this.dot = document.querySelector('.cursor-dot');
        this.outline = document.querySelector('.cursor-outline');
        
        this.cursorVisible = false;
        this.cursorEnlarged = false;
        
        this.endX = window.innerWidth / 2;
        this.endY = window.innerHeight / 2;
        this.cursorX = 0;
        this.cursorY = 0;
        this.outlineX = 0;
        this.outlineY = 0;
        
        this.requestRef = null;
        
        this.init();
    }
    
    init() {
        document.addEventListener('mousedown', () => {
            this.cursorEnlarged = true;
            this.toggleCursorSize();
        });
        
        document.addEventListener('mouseup', () => {
            this.cursorEnlarged = false;
            this.toggleCursorSize();
        });
        
        document.addEventListener('mousemove', (e) => {
            this.cursorVisible = true;
            this.toggleCursorVisibility();
            
            this.endX = e.clientX;
            this.endY = e.clientY;
            
            this.dot.style.top = this.endY + 'px';
            this.dot.style.left = this.endX + 'px';
        });
        
        document.addEventListener('mouseenter', () => {
            this.cursorVisible = true;
            this.toggleCursorVisibility();
            this.dot.style.opacity = 1;
            this.outline.style.opacity = 1;
        });
        
        document.addEventListener('mouseleave', () => {
            this.cursorVisible = false;
            this.toggleCursorVisibility();
            this.dot.style.opacity = 0;
            this.outline.style.opacity = 0;
        });
        
        this.animateOutline();
    }
    
    animateOutline() {
        this.outlineX += (this.endX - this.outlineX) * 0.15;
        this.outlineY += (this.endY - this.outlineY) * 0.15;
        
        this.outline.style.top = this.outlineY + 'px';
        this.outline.style.left = this.outlineX + 'px';
        
        this.requestRef = requestAnimationFrame(() => this.animateOutline());
    }
    
    toggleCursorSize() {
        if (this.cursorEnlarged) {
            this.dot.style.transform = 'translate(-50%, -50%) scale(2)';
            this.outline.style.transform = 'translate(-50%, -50%) scale(1.5)';
        } else {
            this.dot.style.transform = 'translate(-50%, -50%) scale(1)';
            this.outline.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }
    
    toggleCursorVisibility() {
        if (this.cursorVisible) {
            this.cursor.style.opacity = 1;
        } else {
            this.cursor.style.opacity = 0;
        }
    }
}

if (window.innerWidth > 768) {
    new CustomCursor();
}

// Smooth Scrolling Navigation
document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.section');
    
    // Update active nav item on scroll
    const updateActiveNav = () => {
        let current = '';
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            if (scrollY >= sectionTop - 200) {
                current = section.getAttribute('id');
            }
        });
        
        navItems.forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('data-section') === current) {
                item.classList.add('active');
            }
        });
    };
    
    window.addEventListener('scroll', updateActiveNav);
    
    // Smooth scroll on nav click
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.getAttribute('href');
            const targetSection = document.querySelector(targetId);
            
            if (targetSection) {
                targetSection.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});

// Typing Animation
class TypingAnimation {
    constructor(element, text, speed = 50) {
        this.element = element;
        this.text = text;
        this.speed = speed;
        this.index = 0;
        
        this.type();
    }
    
    type() {
        if (this.index < this.text.length) {
            this.element.textContent += this.text.charAt(this.index);
            this.index++;
            setTimeout(() => this.type(), this.speed);
        }
    }
}

// Intersection Observer for Animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.animationPlayState = 'running';
            
            // Trigger progress bar animations
            const progressBars = entry.target.querySelectorAll('.progress-fill');
            progressBars.forEach(bar => {
                const width = bar.style.width;
                bar.style.width = '0';
                setTimeout(() => {
                    bar.style.width = width;
                }, 200);
            });
            
            // Trigger timeline animations
            const timelineItems = entry.target.querySelectorAll('.timeline-item');
            timelineItems.forEach((item, index) => {
                setTimeout(() => {
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                }, index * 200);
            });
        }
    });
}, observerOptions);

// Observe elements
document.addEventListener('DOMContentLoaded', () => {
    const animatedElements = document.querySelectorAll(
        '.fade-in-up, .timeline-item, .experience-card, .publication-card, .stat-card'
    );
    
    animatedElements.forEach(el => observer.observe(el));
});

// Abstract Tooltip
document.addEventListener('DOMContentLoaded', () => {
    const paperTitles = document.querySelectorAll('[data-abstract]');
    const tooltip = document.getElementById('abstract-tooltip');
    const tooltipText = document.getElementById('tooltip-text');
    
    paperTitles.forEach(title => {
        title.addEventListener('mouseenter', (e) => {
            const abstract = title.getAttribute('data-abstract');
            tooltipText.textContent = abstract;
            tooltip.style.display = 'block';
            
            const rect = title.getBoundingClientRect();
            tooltip.style.left = rect.left + 'px';
            tooltip.style.top = (rect.bottom + 20) + 'px';
            
            // Adjust position if tooltip goes off screen
            const tooltipRect = tooltip.getBoundingClientRect();
            if (tooltipRect.right > window.innerWidth) {
                tooltip.style.left = (window.innerWidth - tooltipRect.width - 20) + 'px';
            }
            if (tooltipRect.bottom > window.innerHeight) {
                tooltip.style.top = (rect.top - tooltipRect.height - 20) + 'px';
            }
        });
        
        title.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
    });
    
    // Hide tooltip on scroll
    window.addEventListener('scroll', () => {
        tooltip.style.display = 'none';
    });
});

// Terminal Commands Animation
document.addEventListener('DOMContentLoaded', () => {
    const commands = document.querySelectorAll('.typing-text');
    
    commands.forEach((cmd, index) => {
        cmd.style.animationDelay = `${index * 1}s`;
    });
});

// Parallax Effect
window.addEventListener('scroll', () => {
    const scrolled = window.pageYOffset;
    const parallaxElements = document.querySelectorAll('.floating-stats');
    
    parallaxElements.forEach(element => {
        const speed = 0.5;
        element.style.transform = `translateY(${scrolled * speed}px)`;
    });
});

// Matrix Rain Effect (Optional - can be added to specific sections)
class MatrixRain {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.columns = [];
        this.fontSize = 14;
        this.chars = "01ⰰⰱⰲⰳⰴⰵⰶⰷⰸⰹⰺⰻⰼⰽⰾⰿⱀⱁⱂⱃⱄⱅⱆⱇⱈⱉⱊⱋⱌⱍⱎⱏ";
        
        this.init();
        this.animate();
    }
    
    init() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        const columnCount = Math.floor(this.canvas.width / this.fontSize);
        
        for (let i = 0; i < columnCount; i++) {
            this.columns[i] = Math.floor(Math.random() * this.canvas.height / this.fontSize);
        }
    }
    
    animate() {
        this.ctx.fillStyle = 'rgba(10, 10, 15, 0.05)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#00ff41';
        this.ctx.font = `${this.fontSize}px monospace`;
        
        for (let i = 0; i < this.columns.length; i++) {
            const char = this.chars[Math.floor(Math.random() * this.chars.length)];
            const x = i * this.fontSize;
            const y = this.columns[i] * this.fontSize;
            
            this.ctx.fillText(char, x, y);
            
            if (y > this.canvas.height && Math.random() > 0.975) {
                this.columns[i] = 0;
            }
            
            this.columns[i]++;
        }
        
        requestAnimationFrame(() => this.animate());
    }
}

// Glitch Text Effect
document.addEventListener('DOMContentLoaded', () => {
    const glitchTexts = document.querySelectorAll('.glitch-text');
    
    glitchTexts.forEach(text => {
        setInterval(() => {
            if (Math.random() > 0.95) {
                text.style.animation = 'none';
                setTimeout(() => {
                    text.style.animation = '';
                }, 100);
            }
        }, 3000);
    });
});
